import { VoiceReferenceService } from './voice-reference.service.js';
import { Optional } from '@nestjs/common';
import { ExtendVideoDto } from './dto/extend-video.dto.js';
import { VideoContinuationService } from './video-continuation.service.js';
import { createHash } from 'node:crypto';
import { BillingService } from './billing.service.js';
import { publicService, quoteCredits } from './credit-pricing.js';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AccessTokenPayload } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CreateJobDto } from './dto/create-job.dto.js';
import { GenerationJob } from './entities/generation-job.entity.js';
import { ImageService } from './image.service.js';
import { JobRunnerService } from './job-runner.service.js';
import { getPreset, getService, SERVICES } from './services.catalog.js';
import { StorageService } from './storage.service.js';

export function toJobResponse(job: GenerationJob) {
  return {
    id: job.id,
    service: job.service,
    preset: job.preset,
    status: job.status,
    params: { ...job.params, voiceReference: undefined, plannedScenes: undefined, inputs: undefined, sourceVideoPath: undefined, referenceImagePath: undefined, assetId: undefined },
    prompt: job.prompt,
    creditsReserved: job.creditsReserved,
    creditsCharged: job.creditsCharged,
    billingStatus: job.billingStatus,
    error: job.error ? job.params.hasVoiceReference && job.error.includes('AccessDenied.Unpurchased')
      ? 'Voice-reference generation requires activation in the provider account. Your credits have been returned.'
      : job.service === 'character_swap' && job.error.includes('AccessDenied.Unpurchased')
      ? 'Character replacement is awaiting service activation. Your reserved credits have been returned. Please try again later.'
      : 'We could not complete this generation. Please try again or contact support with the job ID.' : null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    outputs: job.outputs.map((output, index) => ({
      index,
      mimeType: output.mimeType,
      width: output.width ?? null,
      height: output.height ?? null,
      bytes: output.bytes,
    })),
  };
}

@Controller('generation')
export class GenerationController {
  constructor(
    @InjectRepository(GenerationJob)
    private readonly jobs: Repository<GenerationJob>,
    private readonly runner: JobRunnerService,
    private readonly storage: StorageService,
    private readonly images: ImageService,
    private readonly billing: BillingService,
    @Optional() private readonly continuation?: VideoContinuationService,
    @Optional() private readonly voice?: VoiceReferenceService,
  ) {}

  @Get('catalog')
  catalog() {
    return { services: SERVICES.map(service=>({...publicService(service),...(service.id==='video_ad'?{voiceReferenceConfigured:this.voice?.enabled ?? false,voiceReferenceReady:this.voice?.ready ?? false}:{})})) };
  }

  @Get('jobs')
  async list(@CurrentUser() user: AccessTokenPayload) {
    const jobs = await this.jobs.find({
      where: { userId: user.sub },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return { jobs: jobs.map(toJobResponse) };
  }

  @Get('jobs/:id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string) {
    return toJobResponse(await this.findOwned(user.sub, id));
  }

  @Get('jobs/:id/retry')
  async retry(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string) {
    const job = await this.findOwned(user.sub, id);
    return {
      ...toJobResponse(job),
      params: {
        ...toJobResponse(job).params,
        inputs: Array.isArray(job.params.inputs) ? job.params.inputs : [],
        voiceReference: typeof job.params.voiceReference==='string' ? job.params.voiceReference : undefined,
      },
    };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('jobs/:id/extend')
  async extend(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string, @Body() dto: ExtendVideoDto) {
    const source = await this.findOwned(user.sub, id);
    if(source.status !== 'succeeded' || !source.outputs[0]?.mimeType.startsWith('video/'))
      throw new BadRequestException('Only a completed video can be extended');
    if(!dto.description.trim()) throw new BadRequestException('Describe the continuation');
    const service=getService('video_ad')!;
    const credits=quoteCredits(service,{...dto,service:'video_ad',preset:'custom'});
    if(dto.expectedCredits!==credits)throw new BadRequestException('The credit price has changed. Reload the page.');
    const hash=createHash('sha256').update(JSON.stringify({sourceId:id,...dto})).digest('hex');
    const previous=await this.jobs.findOneBy({userId:user.sub,requestId:dto.requestId});
    if(previous){
      if(previous.requestHash!==hash)throw new BadRequestException('Request already used. Reload the page.');
      return toJobResponse(previous);
    }
    if(!this.continuation)throw new BadRequestException('Video continuation is unavailable');
    const info=await this.continuation.inspect(this.storage.absolute(source.outputs[0].path));
    if(info.duration+dto.duration>120)throw new BadRequestException('The combined video must be at most 120 seconds');
    const aspectRatio=info.width>=info.height?'16:9':'9:16';
    const {job,created}=await this.billing.reserve(user.sub,dto.requestId,hash,credits,{
      service:'video_ad',preset:'custom',status:'queued',outputs:[],
      params:{description:dto.description.trim(),videoModel:dto.videoModel,duration:dto.duration,aspectRatio,extensionSourceJobId:id,continuationMethod:'last_frame',sourceDuration:info.duration},
    });
    if(created)this.runner.enqueue(job.id);
    return toJobResponse(job);
  }

  /** Генерация стоит денег — лимит строже общего */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('jobs')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateJobDto,
  ) {
    const service = getService(dto.service);
    if (!service) throw new NotFoundException('Service not found');
    if (!getPreset(service, dto.preset))
      throw new BadRequestException('Unknown preset');

    if (service.id === 'video_ad' && dto.preset === 'custom' && !dto.description?.trim()) {
      throw new BadRequestException('Write your custom prompt');
    }

    const inputs = dto.inputs ?? [];
    if (inputs.length < service.inputImages.min) {
      throw new BadRequestException(
        `Upload at least ${service.inputImages.min} photo(s)`,
      );
    }
    if (inputs.length > service.inputImages.max) {
      throw new BadRequestException(`Up to ${service.inputImages.max} photos`);
    }
    if (service.requiresConsent && !dto.consent) {
      throw new BadRequestException(
        'Confirm you have the right to use these photos of a person',
      );
    }
    if (!inputs.length && !dto.description?.trim()) {
      throw new BadRequestException('Describe what you want to generate');
    }

    const credits = quoteCredits(service, dto);
    if (dto.expectedCredits !== credits)
      throw new BadRequestException('The credit price has changed. Reload the page before generating.');
    const hash = createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    const previous = await this.jobs.findOneBy({ userId: user.sub, requestId: dto.requestId });
    if (previous) {
      if (previous.requestHash !== hash) throw new BadRequestException('Request already used. Reload the page.');
      return toJobResponse(previous);
    }
    if(dto.voiceReference && (service.id!=='video_ad' || dto.videoModel==='premium'))throw new BadRequestException('Voice references are available with Draft and Standard video quality');
    if(dto.voiceReference && !this.voice?.enabled)throw new BadRequestException('Voice-reference generation is not connected yet');
    if(dto.voiceReference && !this.voice?.ready)throw new BadRequestException('Voice-reference generation is awaiting model activation. No credits have been charged.');
    const voice=dto.voiceReference ? await this.voice!.prepare(dto.voiceReference) : undefined;
    const prepared = await Promise.all(
      inputs.map((input) => this.images.prepareInput(input)),
    );

    const { job, created } = await this.billing.reserve(user.sub, dto.requestId, hash, credits, {
        userId: user.sub,
        service: dto.service,
        preset: dto.preset,
        status: 'queued',
        outputs: [],
        params: {
          description: dto.description ?? null,
          count: dto.count ?? 1,
          marketplace: dto.marketplace ?? null,
          aspectRatio: dto.aspectRatio ?? null,
          outputWidth: dto.outputWidth ?? null,
          outputHeight: dto.outputHeight ?? null,
          title: dto.title ?? null,
          badge: dto.badge ?? null,
          videoModel: dto.videoModel ?? null,
          duration: dto.duration ?? null,
          inputs: prepared,
          ...(voice ? {voiceReference:voice.dataUrl,voiceDuration:voice.duration,hasVoiceReference:true} : {}),
        },
      });

    if (created) this.runner.enqueue(job.id);
    return toJobResponse(job);
  }

  @Get('jobs/:id/files/:index')
  async file(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: Response,
  ) {
    const job = await this.findOwned(user.sub, id);
    const output = job.outputs[index];
    if (!output) throw new NotFoundException('File not found');

    res.setHeader('content-type', output.mimeType);
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    this.storage.stream(output.path).pipe(res);
  }

  private async findOwned(userId: string, id: string): Promise<GenerationJob> {
    const job = await this.jobs.findOneBy({ id, userId });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
