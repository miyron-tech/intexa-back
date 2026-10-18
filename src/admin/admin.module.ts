import { EconomicsService } from './economics.service.js';
import { GenerationModule } from '../generation/generation.module.js';
import { Module } from '@nestjs/common';
import { AdminController, PlansController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminGuard } from './admin.guard.js';
@Module({
  imports: [GenerationModule],
  controllers: [AdminController, PlansController],
  providers: [AdminService, AdminGuard, EconomicsService],
})
export class AdminModule {}
