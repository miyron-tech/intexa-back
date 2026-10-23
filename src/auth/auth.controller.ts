import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { toUserResponse } from '../users/user.response.js';
import { UsersService } from '../users/users.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/credentials.dto.js';
import { AuthService } from './auth.service.js';
import type { AccessTokenPayload } from './auth.types.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { LoginDto, RegisterDto } from './dto/credentials.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';

// Строже глобального лимита: защита от перебора паролей
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) { return this.passwordReset.request(dto.email); }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) { return this.passwordReset.reset(dto.token, dto.password); }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    const { user, tokens } = await this.auth.register(dto.email, dto.password, {
      userAgent,
    });
    return { user: toUserResponse(user), tokens };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    const { user, tokens } = await this.auth.login(dto.email, dto.password, {
      userAgent,
    });
    return { user: toUserResponse(user), tokens };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return { tokens: await this.auth.refresh(dto.refreshToken, { userAgent }) };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() current: AccessTokenPayload) {
    await this.auth.logout(current.sid);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() current: AccessTokenPayload) {
    await this.auth.revokeAllSessions(current.sub);
  }

  @Get('me')
  async me(@CurrentUser() current: AccessTokenPayload) {
    const user = await this.users.findById(current.sub);
    if (!user) throw new NotFoundException('User not found');
    return toUserResponse(user);
  }
}
