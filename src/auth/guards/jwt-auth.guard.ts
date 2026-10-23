import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AccessTokenPayload } from '../auth.types.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DataSource,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AccessTokenPayload }>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Authentication required');
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      const [user] = await this.db.query(`SELECT u.id FROM users u WHERE u.id=$1 AND
        (u.password_changed_at IS NULL OR EXISTS (SELECT 1 FROM refresh_tokens r
         WHERE r.id=$2 AND r.user_id=u.id AND r.created_at>=u.password_changed_at))`, [payload.sub,payload.sid]);
      if (!user) throw new UnauthorizedException();
      request.user = { sub: payload.sub, sid: payload.sid };
      return true;
    } catch {
      throw new UnauthorizedException('Token is invalid or expired');
    }
  }
}
