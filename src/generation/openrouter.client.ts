import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProviderUsage, UsageReporter } from './billing.service.js';
import type { Env } from '../config/env.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

/** Без таймаута зависший запрос держал бы задачу в статусе running вечно */
const TIMEOUTS_MS = {
  text: 60_000,
  image: 300_000,
  video: 60_000,
  download: 180_000,
};

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  costUsd: number;
}

export interface VideoJobStatus {
  id: string;
  status:
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired';
  urls: string[];
  costUsd: number;
  error?: string;
  usage?: ProviderUsage;
}

interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.get('OPENROUTER_API_KEY', { infer: true })}`,
      'content-type': 'application/json',
      // OpenRouter показывает эти поля в рейтинге приложений
      'http-referer': this.config.get('FRONTEND_URL', { infer: true }),
      'x-title': 'Aigenerate',
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = TIMEOUTS_MS.text,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: this.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      this.logger.error(`OpenRouter ${path}: ${String(error)}`);
      throw new HttpException(
        timedOut
          ? 'The generation service timed out'
          : 'Could not reach the generation service',
        504,
      );
    }
    let text: string;
    try {text=await res.text();} catch {throw new HttpException('Could not read the generation service response',502);}
    if (!res.ok) {
      this.logger.error(
        `OpenRouter ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
      throw new HttpException(
        this.readableError(text, res.status),
        res.status >= 500 ? 502 : res.status,
      );
    }
    try {return JSON.parse(text) as T;} catch {throw new HttpException('The generation service returned an incomplete response',502);}
  }

  private readableError(body: string, status: number): string {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) return `OpenRouter: ${parsed.error.message}`;
    } catch {
      // тело не JSON — отдаём общий текст ниже
    }
    return status === 429
      ? 'OpenRouter rate limit reached, try again shortly'
      : 'The generation service returned an error';
  }

  /** Текстовый запрос: сборка промптов из описания на русском */
  async complete(model: string, system: string, user: string, report?: UsageReporter, maxTokens = 400, json = false): Promise<string> {
    const data = await this.request<{
      id?: string;
      usage?: ProviderUsage;
      choices: { message: { content: string } }[];
    }>('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        reasoning: { enabled: false },
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        temperature: 0.7,
      }),
    });
    await report?.(data.usage, data.id);
    return data.choices[0]?.message?.content?.trim() ?? '';
  }

  /** Генерация или редактирование изображения; referenceImages — исходники в виде data URL */
  async generateImage(
    model: string,
    prompt: string,
    referenceImages: string[] = [],
    report?: UsageReporter,
  ): Promise<ImageResult> {
    const content: ChatContentPart[] = [{ type: 'text', text: prompt }];
    for (const url of referenceImages) {
      content.push({ type: 'image_url', image_url: { url } });
    }

    const data = await this.request<{
      choices: { message: { images?: { image_url: { url: string } }[] } }[];
      id?: string;
      usage?: ProviderUsage;
    }>(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model,
          modalities: ['image', 'text'],
          messages: [{ role: 'user', content }],
        }),
      },
      TIMEOUTS_MS.image,
    );

    await report?.(data.usage, data.id);
    const images = (data.choices[0]?.message?.images ?? []).map((image) =>
      this.decodeDataUrl(image.image_url.url),
    );
    return { images, costUsd: data.usage?.cost ?? 0 };
  }

  async createVideo(body: Record<string, unknown>): Promise<string> {
    const data = await this.request<{ id: string }>(
      '/videos',
      { method: 'POST', body: JSON.stringify(body) },
      TIMEOUTS_MS.video,
    );
    return data.id;
  }

  async getVideo(jobId: string): Promise<VideoJobStatus> {
    const data = await this.request<{
      id: string;
      status: VideoJobStatus['status'];
      unsigned_urls?: string[];
      usage?: ProviderUsage;
      error?: { message?: string } | string;
    }>(`/videos/${jobId}`, {}, TIMEOUTS_MS.video);

    const error =
      typeof data.error === 'string' ? data.error : data.error?.message;
    return {
      id: data.id,
      status: data.status,
      urls: data.unsigned_urls ?? [],
      costUsd: data.usage?.cost ?? 0,
      error,
      usage: data.usage,
    };
  }

  /** Файлы видео отдаются без подписи — нужен тот же заголовок авторизации */
  async downloadVideo(url: string): Promise<GeneratedImage> {
    const res = await fetch(url, {
      headers: { authorization: this.headers.authorization },
    });
    if (!res.ok)
      throw new HttpException('Could not download the finished video', 502);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'video/mp4',
    };
  }

  private decodeDataUrl(url: string): GeneratedImage {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (!match)
      throw new HttpException(
        'The model returned an image in an unknown format',
        502,
      );
    return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
  }
}
