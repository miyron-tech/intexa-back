import { WanVoiceClient } from './wan-voice.client.js';
import { VoiceReferenceService } from './voice-reference.service.js';
import { VideoContinuationService } from './video-continuation.service.js';
import { BillingService } from './billing.service.js';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GenerationJob } from './entities/generation-job.entity.js';
import { GenerationController } from './generation.controller.js';
import { ImageService } from './image.service.js';
import { JobRunnerService } from './job-runner.service.js';
import { OpenRouterClient } from './openrouter.client.js';
import { StorageService } from './storage.service.js';
import { CharacterSwapController } from './character-swap.controller.js';
import { CharacterSwapService } from './character-swap.service.js';
import { WanAnimateClient } from './wan-animate.client.js';

@Module({
  imports: [TypeOrmModule.forFeature([GenerationJob])],
  controllers: [GenerationController, CharacterSwapController],
  exports: [StorageService],
  providers: [WanVoiceClient, VoiceReferenceService, VideoContinuationService, BillingService, OpenRouterClient, StorageService, ImageService, JobRunnerService, WanAnimateClient, CharacterSwapService],
})
export class GenerationModule {}
