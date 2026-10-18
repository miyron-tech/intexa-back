import {
  Body,
  Res,
  ParseUUIDPipe,
  ParseIntPipe,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { EconomicsService } from './economics.service.js';
import { StorageService } from '../generation/storage.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { AccessTokenPayload } from '../auth/auth.types.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';
import { TopUpDto, UpdatePlanDto } from './dto/admin.dto.js';
function pageNumber(value?: string) {
  const n = Number(value ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 100000)
    throw new BadRequestException('Invalid page');
  return n;
}
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly economics: EconomicsService, private readonly storage: StorageService) {}
  @Get('economics') economicsSummary() { return this.economics.summary(); }
  @Get('users/:id') userEconomics(@Param('id', ParseUUIDPipe) id: string, @Query('page') page?: string) {
    return this.economics.user(id, pageNumber(page));
  }
  @Get('generations/:id/files/:index') async file(
    @Param('id', ParseUUIDPipe) id: string, @Param('index', ParseIntPipe) index: number, @Res() res: Response,
  ) {
    const output = await this.economics.output(id,index);
    res.setHeader('content-type',output.mimeType);
    res.setHeader('cache-control','private, no-store');
    this.storage.stream(output.path).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
  }
  @Get('summary') summary() {
    return this.admin.summary();
  }
  @Get('users') users(@Query('q') q = '', @Query('page') page?: string) {
    return this.admin.users(q.slice(0, 320), pageNumber(page));
  }
  @Get('top-ups') topUps(@Query('q') q = '', @Query('page') page?: string) {
    return this.admin.topUps(q.slice(0, 320), pageNumber(page));
  }
  @Get('plans') plans() {
    return this.admin.plans();
  }
  @Patch('plans/:id') updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() actor: AccessTokenPayload,
  ) {
    return this.admin.updatePlan(id, dto, actor.sub);
  }
  @Post('top-ups') addTopUp(
    @Body() dto: TopUpDto,
    @CurrentUser() actor: AccessTokenPayload,
  ) {
    return this.admin.addTopUp(dto, actor.sub);
  }
}
@Controller('plans')
export class PlansController {
  constructor(private readonly admin: AdminService) {}
  @Public() @Get() plans() {
    return this.admin.plans();
  }
}
