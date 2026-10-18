import { Body, Controller, Get, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { IsDivisibleBy, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { AccessTokenPayload } from '../auth/auth.types.js';
import { PaymentsService } from './payments.service.js';
import { CUSTOM_PACKAGE } from './custom-package.js';
class CheckoutDto {
  @IsIn(['creator', 'studio', 'custom']) planId: string;
  @ValidateIf((dto: CheckoutDto) => dto.planId === 'custom' || dto.customAmountCents !== undefined)
  @IsInt() @Min(CUSTOM_PACKAGE.minAmountCents) @Max(CUSTOM_PACKAGE.maxAmountCents)
  @IsDivisibleBy(CUSTOM_PACKAGE.stepAmountCents)
  customAmountCents?: number;
  @IsOptional() @IsEmail() @Length(3,254) email?: string;
  @IsString() @Length(1,100) firstName: string;
  @IsString() @Length(1,100) lastName: string;
  @IsString() @Length(1,200) addressLine1: string;
  @IsString() @Length(1,100) city: string;
  @Matches(/^[A-Z]{2}$/) countryCode: string;
  @IsString() @Length(1,20) postalCode: string;
}
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post('checkout')
  checkout(@CurrentUser() user: AccessTokenPayload, @Body() dto: CheckoutDto) { return this.payments.checkout(user.sub, dto.planId, dto); }
  @Get()
  list(@CurrentUser() user: AccessTokenPayload) { return this.payments.list(user.sub); }
  @Get('custom-package')
  customPackage() { return CUSTOM_PACKAGE; }
  @Get('billing-profile')
  async profile(@CurrentUser() user: AccessTokenPayload) { return { details: await this.payments.profile(user.sub) }; }
  @Public() @SkipThrottle() @Post('wemopay/webhook') @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('signature') signature?: string) { return this.payments.webhook(req.rawBody, signature); }
}
