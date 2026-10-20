import { VoiceReferenceService } from './voice-reference.service.js';
import { planVideo } from './video-plan.js';
import { VideoContinuationService } from './video-continuation.service.js';
import { BillingService } from './billing.service.js';
import { HttpException, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { CharacterSwapService } from './character-swap.service.js';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Env } from '../config/env.js';
import { GenerationJob } from './entities/generation-job.entity.js';
import { ImageService } from './image.service.js';
import { OpenRouterClient } from './openrouter.client.js';
import {
  getPreset,
  getService,
  type ServiceDefinition,
  type VideoModelOption,
} from './services.catalog.js';
import { StorageService } from './storage.service.js';

/** Одновременно выполняемых задач на процесс. Очереди пока нет — это её временная замена. */
const MAX_CONCURRENT = 2;
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_TIMEOUT_MS = 10 * 60_000;

const PROMPT_SYSTEM =
  'You turn short product descriptions, written in any language, into English prompts for an image or video generation model. ' +
  'Answer with the prompt only: one paragraph, concrete visual nouns, no preamble, no quotes, no markdown.';

@Injectable()
export class JobRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobRunnerService.name);
  private running = 0;
  private readonly pending: string[] = [];

  constructor(
    @InjectRepository(GenerationJob)
    private readonly jobs: Repository<GenerationJob>,
    private readonly openRouter: OpenRouterClient,
    private readonly storage: StorageService,
    private readonly images: ImageService,
    private readonly config: ConfigService<Env, true>,
    private readonly billing: BillingService,
    @Optional() private readonly characterSwap?: CharacterSwapService,
    @Optional() private readonly continuation?: VideoContinuationService,
    @Optional() private readonly voice?: VoiceReferenceService,
  ) {}

  /** Задачи, зависшие в running после перезапуска процесса, честно помечаем упавшими */
  async onApplicationBootstrap(): Promise<void> {
    const interrupted = await this.jobs.findBy({ status: 'running' });
    for (const job of interrupted) {
      await this.billing.finish(job.id, false, job.outputs ?? [], 'Generation interrupted by a server restart');
      if(job.service === 'character_swap' && typeof job.params.assetId === 'string') await this.storage.removeJob(job.userId,job.params.assetId);
    }
    const queued = await this.jobs.findBy({ status: 'queued' });
    for (const job of queued) this.enqueue(job.id);
  }

  enqueue(jobId: string): void {
    this.pending.push(jobId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < MAX_CONCURRENT && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (!jobId) return;
      this.running += 1;
      void this.run(jobId)
        .catch((error: unknown) =>
          this.logger.error(`Задача ${jobId}: ${String(error)}`),
        )
        .finally(() => {
          this.running -= 1;
          void this.drain();
        });
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job || job.status !== 'queued') return;

    const service = getService(job.service);
    if (!service && job.service !== 'character_swap') return void this.fail(job, 'Service not found');

    const claimed = await this.jobs.update({ id: job.id, status: 'queued' }, { status: 'running' });
    if (!claimed.affected) return;
    job.status = 'running';

    try {
      if (job.service === 'character_swap') {
        if(!this.characterSwap) throw new Error('Character replacement is not connected');
        await this.characterSwap.run(job);
      } else if (service!.kind === 'text') {
        await this.runContent(job);
      } else if (service!.kind === 'video') {
        await this.runVideo(job, service!);
      } else {
        await this.runImages(job, service!);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Задача ${job.id} упала: ${message}`);
      await this.fail(job, message);
    }
  }

  private async fail(job: GenerationJob, error: string): Promise<void> {
    await this.billing.finish(job.id, false, job.outputs ?? [], error);
  }

  private async runContent(job: GenerationJob): Promise<void> {
    const description = String(job.params.description ?? '').trim();
    if (!description) throw new Error('Describe your content first');
    const model = this.config.get('OPENROUTER_TEXT_MODEL', { infer: true });
    const system = 'You write useful TikTok copy based on the user\'s video or product description. ' +
      'Reply in the same language as the user unless they request another. Give 3 distinct, concise caption options, ' +
      'each with an opening hook, a natural call to action, and 3–5 relevant hashtags. ' +
      'Use readable plain text with short section labels. Do not invent facts about the product, guaranteed reach, ' +
      'trending tags or claims of having watched a video. Follow any requested tone or audience.';
    await this.jobs.update(job.id, { prompt: description, model });
    const report = await this.billing.startUsage(job.id, 'content', model, description);
    const contentResult = await this.openRouter.complete(model, system, description, report, 2000);
    if (!contentResult.trim()) throw new Error('The provider returned no content');
    await this.jobs.update(job.id, { params: { ...job.params, contentResult } });
    await this.billing.finish(job.id, true);
  }

  // --- Изображения ---------------------------------------------------------

  private async runImages(
    job: GenerationJob,
    service: ServiceDefinition,
  ): Promise<void> {
    const params = job.params as {
      description?: string;
      inputs?: string[];
      count?: number;
      marketplace?: string;
      aspectRatio?: string;
      title?: string;
      badge?: string;
      outputWidth?: number;
      outputHeight?: number;
    };

    const prompt = await this.buildPrompt(
      job,
      service,
      params.description ?? '',
    );
    const model = service.imageModel!;
    await this.jobs.update({ id: job.id }, { prompt, model });

    const inputs = params.inputs ?? [];
    const count = Math.min(params.count ?? 1, service.maxOutputs);

    // Один запрос = один вариант: модель возвращает по одной картинке за вызов
    // Wait for every request, including partial failures, so all reported costs are retained.
    const settled = await Promise.allSettled(
      Array.from({ length: count }, async () => {
        const report = await this.billing.startUsage(job.id, 'image', model, prompt);
        return this.openRouter.generateImage(model, prompt, inputs, report);
      }),
    );
    const failed = settled.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const results = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    if (results.some(result => result.images.length === 0))
      throw new Error('The provider did not return every requested variant');

    const spec = service.marketplaces?.find((m) => m.id === params.marketplace);
    const ratioParts = params.aspectRatio?.split(':').map(Number);
    const ratio = ratioParts && ratioParts[0] / ratioParts[1];
    const target = params.outputWidth && params.outputHeight
      ? { width: params.outputWidth, height: params.outputHeight }
      : spec ?? (ratio && Number.isFinite(ratio) && ratio > 0
        ? { width: ratio >= 1 ? 1024 : Math.round(1024 * ratio), height: ratio >= 1 ? Math.round(1024 / ratio) : 1024 }
        : undefined);
    const outputs: GenerationJob['outputs'] = [];
    let index = 0;

    for (const result of results) {
      for (const image of result.images) {
        let buffer = image.buffer;
        let mimeType = image.mimeType;

        if (target) {
          const fitted = await this.images.fitTo(
            buffer,
            target.width,
            target.height,
          );
          buffer = fitted.buffer;
          mimeType = fitted.mimeType;
        }
        if (params.title) {
          const captioned = await this.images.overlayCaption(
            buffer,
            params.title,
            params.badge ?? null,
          );
          buffer = captioned.buffer;
          mimeType = captioned.mimeType;
        }

        const { width, height } = await this.images.describe(buffer);
        const name = `${index}.jpg`;
        const path = await this.storage.save(job.userId, job.id, name, buffer);
        outputs.push({
          path,
          mimeType,
          width,
          height,
          bytes: buffer.byteLength,
        });
        index += 1;
      }
    }

    if (outputs.length === 0) {
      throw new Error(
        'The model returned no images — try changing the description',
      );
    }

    await this.billing.finish(job.id, true, outputs);
  }

  // --- Видео ---------------------------------------------------------------

  private async runVideo(job: GenerationJob, service: ServiceDefinition): Promise<void> {
    const option=service.videoModels?.find(m=>m.id===job.params.videoModel) ?? service.videoModels![0];
    const duration=Number(job.params.duration ?? option.durations[0]);
    const parts=planVideo(duration,option.durations);
    if(parts.length>1 && !this.continuation)throw new Error('Video assembly is unavailable');
    const originalParams={...job.params};
    const savedScenes=job.params.plannedScenes;
    const hasSavedScenes=Array.isArray(savedScenes) && savedScenes.length===parts.length && savedScenes.every(scene=>typeof scene==='string' && scene.trim());
    let scenes=hasSavedScenes ? savedScenes as string[] : parts.map(()=>String(job.params.description ?? ''));
    if(parts.length>1 && !hasSavedScenes) {
      const model=this.config.get('OPENROUTER_TEXT_MODEL',{infer:true});
      const system='Plan consecutive scenes for one video. Return ONLY a JSON object with a "scenes" array of strings, one prompt per segment. Keep subjects, setting, lighting and voice consistent. Divide actions and dialogue chronologically; never repeat the full script in each segment. Preserve the original language and quoted dialogue, and fit spoken words into each segment. Each prompt must stand alone and describe only its segment. No markdown.';
      const input=`Segment lengths: ${parts.join(', ')} seconds. Visual direction: ${getPreset(service,job.preset)?.prompt ?? ''}. User request: ${job.params.description ?? ''}`;
      let planned: string[] | undefined;
      for(let attempt=0;attempt<2;attempt++) {
        const report=await this.billing.startUsage(job.id,'video_plan',model,system+'\n'+input);
        const raw=await this.openRouter.complete(model,system,input,report,8000,true);
        try {
          const result: unknown=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
          const parsed=Array.isArray(result)?result:result && typeof result==='object' && 'scenes' in result?result.scenes:undefined;
          if(Array.isArray(parsed) && parsed.length===parts.length && parsed.every(x=>typeof x==='string' && x.trim() && x.length<=4000)){planned=parsed as string[];break;}
        } catch { /* A truncated or empty plan is retried once before any video call. */ }
      }
      if(!planned)throw new Error('Could not plan the video scenes');
      scenes=planned;
    }
    const completed=Math.min(parts.length,Math.max(0,Number(originalParams.completedSegments ?? 0)));
    let checkpoint: string | undefined=completed>0 && job.outputs[0]?this.storage.absolute(job.outputs[0].path):undefined;
    if(completed>0 && !checkpoint)throw new Error('Saved video checkpoint is unavailable');
    for(let index=completed;index<parts.length;index++) {
      job.params={...originalParams,duration:parts[index],description:scenes[index]};
      const progress={...originalParams,plannedScenes:scenes,segmentDurations:parts,completedSegments:index,totalSegments:parts.length};
      await this.jobs.update(job.id,{params:progress});
      const outputs=await this.runVideoSegment(job,service,checkpoint,index,parts.length>1);
      job.outputs=outputs;
      if(index<parts.length-1)checkpoint=this.storage.absolute(outputs[0].path);
      await this.jobs.update(job.id,{outputs,params:{...progress,completedSegments:index+1}});
    }
    if(parts.reduce((sum,part)=>sum+part,0)>duration) {
      if(!this.continuation)throw new Error('Video trimming is unavailable');
      const target=Number(originalParams.sourceDuration ?? 0)+duration;
      const trimmed=await this.continuation.trim(this.storage.absolute(job.outputs[0].path),target);
      const path=await this.storage.save(job.userId,job.id,'final.mp4',trimmed.buffer);
      job.outputs=[{path,mimeType:'video/mp4',width:trimmed.width,height:trimmed.height,bytes:trimmed.buffer.length}];
    }
    job.params=originalParams;
    await this.billing.finish(job.id,true,job.outputs);
  }

  private async runVideoSegment(
    job: GenerationJob,
    service: ServiceDefinition,
    checkpoint?: string,
    segmentIndex = 0,
    planned = false,
  ): Promise<GenerationJob["outputs"]> {
    const params = job.params as {
      voiceReference?: string;
      extensionSourceJobId?: string;
      description?: string;
      inputs?: string[];
      duration?: number;
      aspectRatio?: string;
      videoModel?: string;
    };

    const option: VideoModelOption =
      service.videoModels?.find((m) => m.id === params.videoModel) ??
      service.videoModels![0];
    const prompt = planned ? params.description ?? '' : await this.buildPrompt(job,service,params.description ?? '');
    await this.jobs.update({ id: job.id }, { prompt, model: option.model });

    let sourcePath: string | undefined = checkpoint;
    let firstFrame = params.inputs?.[0];
    if(checkpoint) {
      firstFrame=await this.continuation!.lastFrame(checkpoint);
    } else if(params.extensionSourceJobId) {
      if(!this.continuation)throw new Error('Video continuation is unavailable');
      const source=await this.jobs.findOneBy({id:params.extensionSourceJobId,userId:job.userId,status:'succeeded'});
      if(!source?.outputs[0]?.mimeType.startsWith('video/'))throw new Error('Source video is unavailable');
      sourcePath=this.storage.absolute(source.outputs[0].path);
      firstFrame=await this.continuation.lastFrame(sourcePath);
    }

    const body: Record<string, unknown> = {
      model: option.model,
      prompt: sourcePath ? `Continue naturally from this first frame. Keep the same subject, setting and lighting. Fill the entire frame, no borders. ${prompt}` : prompt,
      duration: params.duration ?? option.durations[0],
      resolution: option.resolution,
      aspect_ratio: params.aspectRatio ?? '9:16',
    };
    // Фото товара становится первым кадром ролика
    if (firstFrame)
      body.frame_images = [
        {
          type: 'image_url',
          image_url: { url: firstFrame },
          frame_type: 'first_frame',
        },
      ];

    if(params.voiceReference) {
      if(!this.voice)throw new Error('Voice-reference generation is not connected');
      const report=await this.billing.startUsage(job.id,'voice_video','wan3.0-video',String(body.prompt));
      await this.jobs.update(job.id,{model:'wan3.0-video'});
      const segment=await this.voice.generate(params.voiceReference,firstFrame,String(body.prompt),Number(body.duration),option.resolution,String(body.aspect_ratio),report,async id=>{await this.jobs.update(job.id,{remoteId:id});});
      const combined=sourcePath?await this.continuation!.combine(sourcePath,segment):undefined;
      const buffer=combined?.buffer ?? segment;
      const path=await this.storage.save(job.userId,job.id,`voice-segment-${segmentIndex}.mp4`,buffer);
      return [{path,mimeType:'video/mp4',bytes:buffer.length,...(combined?{width:combined.width,height:combined.height}:{})}];
    }

    const report = await this.billing.startUsage(job.id, 'video', option.model, prompt);
    const remoteId = await this.openRouter.createVideo(body);
    await this.jobs.update(job.id, { remoteId });
    const deadline = Date.now() + VIDEO_TIMEOUT_MS;

    for (;;) {
      await new Promise((resolve) =>
        setTimeout(resolve, VIDEO_POLL_INTERVAL_MS),
      );
      let status: Awaited<ReturnType<OpenRouterClient['getVideo']>>;
      try {
        status=await this.openRouter.getVideo(remoteId);
      } catch(error) {
        const code=error instanceof HttpException?error.getStatus():0;
        if((code===429 || code>=500) && Date.now()<deadline) {
          this.logger.warn(`Video ${job.id}: transient status check failure; keeping the same provider task`);
          continue;
        }
        throw error;
      }

      if (['completed','failed','cancelled','expired'].includes(status.status))
        await report(status.usage, remoteId);

      if (status.status === 'completed') {
        const outputs: GenerationJob['outputs'] = [];
        let index = 0;
        for (const url of status.urls) {
          const file = await this.openRouter.downloadVideo(url);
          const combined = sourcePath ? await this.continuation!.combine(sourcePath,file.buffer) : undefined;
          const buffer=combined?.buffer ?? file.buffer;
          const name = `segment-${segmentIndex}-${index}.mp4`;
          const path = await this.storage.save(
            job.userId,
            job.id,
            name,
            buffer,
          );
          outputs.push({
            path,
            mimeType: file.mimeType,
            bytes: buffer.byteLength,
            ...(combined ? {width:combined.width,height:combined.height} : {}),
          });
          index += 1;
        }
        if (outputs.length === 0)
          throw new Error('The provider returned no video file');

        return outputs;
      }

      if (
        status.status === 'failed' ||
        status.status === 'cancelled' ||
        status.status === 'expired'
      ) {
        throw new Error(
          status.error ??
            `Video generation finished with status ${status.status}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error('Video did not finish within 10 minutes');
      }
    }
  }

  // --- Промпт --------------------------------------------------------------

  private async buildPrompt(
    job: GenerationJob,
    service: ServiceDefinition,
    description: string,
  ): Promise<string> {
    if (service.id === 'video_ad' && job.preset === 'custom') {
      const prompt = description.trim();
      if (!prompt) throw new Error('Write your custom prompt');
      return prompt;
    }

    const preset = getPreset(service, job.preset);
    const base = preset?.prompt ?? '';
    if (!description.trim()) return base;

    const model = this.config.get('OPENROUTER_TEXT_MODEL', { infer: true });
    const translationInput = `Style and constraints (keep all of them):\n${base}\n\n` +
      `Subject described by the user:\n${description}\n\nWrite the final English prompt.`;
    const report = await this.billing.startUsage(job.id, 'text', model, `${PROMPT_SYSTEM}\n\n${translationInput}`);
    try {
      const translated = await this.openRouter.complete(
        model,
        PROMPT_SYSTEM,
        translationInput,
        report,
      );
      if (translated) return translated;
    } catch (error) {
      // Перевод не критичен: без него отправим пресет плюс исходное описание
      this.logger.warn(`Не удалось собрать промпт через LLM: ${String(error)}`);
    }
    return `${base}\nSubject: ${description}`;
  }
}
