import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import argon2 from 'argon2';
import { DataSource, IsNull, Repository } from 'typeorm';
import type { Env } from '../config/env.js';
import type { User } from '../users/entities/user.entity.js';
import { UsersService } from '../users/users.service.js';
import type { AccessTokenPayload, AuthTokens } from './auth.types.js';
import { RefreshToken } from './entities/refresh-token.entity.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Окно, в течение которого повтор только что ротированного токена не считается кражей. */
const REUSE_GRACE_MS = 30_000;

interface ClientInfo {
  userAgent?: string;
}

@Injectable()
export class AuthService {
  /** Хэш-заглушка: сравниваем с ней, если пользователь не найден, чтобы время ответа не выдавало существование email. */
  private readonly dummyHash = argon2.hash(randomBytes(16).toString('hex'));

  constructor(
    private readonly users: UsersService,
    private readonly db: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  async register(email: string, password: string, client: ClientInfo) {
    if (await this.users.existsByEmail(email)) {
      throw new ConflictException('This email is already registered');
    }
    const passwordHash = await argon2.hash(password);
    const user = await this.users
      .create(email, passwordHash)
      .catch((error: unknown) => {
        // Гонка двух одновременных регистраций: unique_violation
        if ((error as { code?: string }).code === '23505') {
          throw new ConflictException('This email is already registered');
        }
        throw error;
      });
    return { user, tokens: await this.issueTokens(user.id, client) };
  }

  async login(email: string, password: string, client: ClientInfo) {
    const user = await this.users.findByEmailWithPassword(email);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const valid = await argon2.verify(hash, password);
    if (!user || !valid) {
      throw new UnauthorizedException('Incorrect email or password');
    }
    return {
      user: user as User,
      tokens: await this.issueTokens(user.id, client, undefined, user.passwordHash),
    };
  }

  /** Ротация: старый refresh-токен отзывается, выдаётся новая пара. */
  async refresh(rawToken: string, client: ClientInfo): Promise<AuthTokens> {
    const invalid = new UnauthorizedException(
      'Your session is invalid. Please sign in again',
    );
    const [sessionId, secret] = rawToken.split('.');
    if (!sessionId || !secret || !UUID_RE.test(sessionId)) throw invalid;

    const session = await this.refreshTokens.findOneBy({ id: sessionId });
    if (!session || !this.hashMatches(secret, session.tokenHash)) throw invalid;
    if (session.expiresAt.getTime() <= Date.now()) throw invalid;

    if (!session.revokedAt) {
      const nextSessionId = randomUUID();
      // Условие revoked_at IS NULL: из двух параллельных refresh отзыв выполнит только один
      const { affected } = await this.refreshTokens.update(
        { id: session.id, revokedAt: IsNull() },
        { revokedAt: new Date(), replacedById: nextSessionId },
      );
      if (affected) {
        return this.issueTokens(session.userId, client, nextSessionId, undefined, session.id);
      }
      // Проиграли гонку — дальше решаем как для уже отозванного токена
      const current = await this.refreshTokens.findOneByOrFail({
        id: session.id,
      });
      session.revokedAt = current.revokedAt;
      session.replacedById = current.replacedById;
    }

    // Параллельные запросы (SSR, prefetch) могут прийти с одним и тем же токеном.
    // Если его только что сменила ротация — это не кража, выдаём ещё одну пару.
    const rotatedRecently =
      session.replacedById !== null &&
      Date.now() - session.revokedAt!.getTime() < REUSE_GRACE_MS;
    if (rotatedRecently) {
      return this.issueTokens(session.userId, client, undefined, undefined, session.id);
    }

    // Повторное использование давно отозванного токена — вероятная кража. Гасим все сессии.
    await this.revokeAllSessions(session.userId);
    throw invalid;
  }

  async logout(sessionId: string): Promise<void> {
    await this.refreshTokens.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  private async issueTokens(
    userId: string,
    client: ClientInfo,
    sessionId: string = randomUUID(),
    expectedPasswordHash?: string,
    sourceSessionId?: string,
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });
    const now = Date.now();

    const secret = randomBytes(32).toString('base64url');
    const session = await this.db.transaction(async tx => {
      // Share the account lock with password resets so an in-flight old login or
      // refresh cannot create a session after the reset invalidates its credentials.
      const [current] = await tx.query('SELECT password_hash,password_changed_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!current || (expectedPasswordHash && current.password_hash !== expectedPasswordHash))
        throw new UnauthorizedException('Your session is invalid. Please sign in again');
      if (sourceSessionId && current.password_changed_at) {
        const [source] = await tx.query('SELECT r.id FROM refresh_tokens r JOIN users u ON u.id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.created_at >= u.password_changed_at', [sourceSessionId,userId]);
        if (!source) throw new UnauthorizedException('Your session is invalid. Please sign in again');
      }
      const repo = tx.getRepository(RefreshToken);
      return repo.save(repo.create({
        id: sessionId, userId, tokenHash: this.hash(secret),
        expiresAt: new Date(now + refreshTtl * 1000), revokedAt: null,
        replacedById: null, userAgent: client.userAgent?.slice(0, 512) ?? null,
      }));
    });

    const payload: AccessTokenPayload = { sub: userId, sid: session.id };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: accessTtl,
    });

    return {
      accessToken,
      accessTokenExpiresAt: new Date(now + accessTtl * 1000).toISOString(),
      refreshToken: `${session.id}.${secret}`,
      refreshTokenExpiresAt: session.expiresAt.toISOString(),
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private hashMatches(secret: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(secret), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}
