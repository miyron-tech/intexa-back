import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AccessTokenPayload } from '../auth/auth.types.js';
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly db: DataSource) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AccessTokenPayload }>();
    if (!request.user)
      throw new ForbiddenException('Administrator access required');
    const rows = await this.db.query('SELECT role FROM users WHERE id=$1', [
      request.user.sub,
    ]);
    if (rows[0]?.role !== 'admin')
      throw new ForbiddenException('Administrator access required');
    return true;
  }
}
