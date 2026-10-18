import { LONG_VIDEO_DURATIONS, planVideo } from './video-plan.js';
import { BadRequestException } from '@nestjs/common';
import type { CreateJobDto } from './dto/create-job.dto.js';
import type { ServiceDefinition } from './services.catalog.js';

export const PRICING_VERSION = 'credits-2026-09-v1';
export const IMAGE_CREDITS = 10;
export const VIDEO_CREDITS: Record<string, number> = {
  draft: 10,
  standard: 20,
  premium: 25,
};

export function quoteCredits(
  service: ServiceDefinition,
  dto: CreateJobDto,
): number {
  if (
    dto.aspectRatio &&
    !service.aspectRatios?.some((r) => r.id === dto.aspectRatio)
  )
    throw new BadRequestException('Unsupported aspect ratio');
  if (service.kind === 'video') {
    const option = service.videoModels?.find(
      (m) => m.id === (dto.videoModel ?? service.videoModels?.[0]?.id),
    );
    if (!option) throw new BadRequestException('Unknown quality option');
    const parts=planVideo(dto.duration ?? option.durations[0],option.durations);
    return VIDEO_CREDITS[option.id] * parts.reduce((sum,part)=>sum+part,0);
  }
  const count = dto.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > service.maxOutputs)
    throw new BadRequestException('Invalid number of variants');
  return IMAGE_CREDITS * count;
}

export function publicService(service: ServiceDefinition) {
  const {
    imageModel: _imageModel,
    presets,
    videoModels,
    ...publicFields
  } = service;
  return {
    ...publicFields,
    creditsPerImage: IMAGE_CREDITS,
    pricingVersion: PRICING_VERSION,
    presets: presets.map(({ prompt: _prompt, ...preset }) => preset),
    videoModels: videoModels?.map(
      ({ model: _model, usdPerSecond: _usd, ...option }) => ({
        ...option,
        creditsPerSecond: VIDEO_CREDITS[option.id],
        totalDurations: LONG_VIDEO_DURATIONS,
        durationPrices: Object.fromEntries(LONG_VIDEO_DURATIONS.map(duration=>[duration,planVideo(duration,option.durations).reduce((sum,part)=>sum+part,0)*VIDEO_CREDITS[option.id]])),
      }),
    ),
  };
}
