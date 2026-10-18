import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export const WAN_ANIMATE_MODEL = 'wan2.2-animate-mix';

@Injectable()
export class WanAnimateClient {
  private readonly logger = new Logger(WanAnimateClient.name);
  constructor(private readonly config: ConfigService) {}
  get enabled() { return Boolean(this.config.get<string>('DASHSCOPE_API_KEY')); }
  private get base() { return (this.config.get<string>('DASHSCOPE_BASE_URL') || 'https://dashscope-intl.aliyuncs.com/api/v1').replace(/\/$/, ''); }
  private async request(path: string, body?: unknown) {
    if (!this.enabled) throw new ServiceUnavailableException('Character replacement is not connected yet. No credits have been charged.');
    const res = await fetch(this.base + path, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${this.config.get<string>('DASHSCOPE_API_KEY')}`, 'content-type': 'application/json', 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(()=>({}));
    if (!res.ok || data.code) {
      const code = typeof data.code === 'string' ? data.code.replace(/[^a-zA-Z0-9._-]/g,'').slice(0,100) : 'unknown';
      this.logger.warn(`Wan Animate HTTP ${res.status}; provider code ${code}`);
      if (code === 'AccessDenied.Unpurchased') throw new ServiceUnavailableException('Character replacement is not activated in the provider account (AccessDenied.Unpurchased).');
      throw new BadGatewayException('The character replacement provider could not process this request.');
    }
    return data;
  }
  // Model Studio temporary uploads allow local testing without exposing localhost files.
  async upload(path: string, mimeType: string, extension: string, model = WAN_ANIMATE_MODEL) {
    const { data } = await this.request(`/uploads?action=getPolicy&model=${encodeURIComponent(model)}`);
    const host = new URL(data.upload_host);
    if (host.protocol !== 'https:' || !host.hostname.endsWith('.aliyuncs.com')) throw new BadGatewayException('Invalid upload host');
    const key = `${data.upload_dir}/${randomUUID()}.${extension}`;
    const form = new FormData();
    for (const [name,value] of Object.entries({ OSSAccessKeyId:data.oss_access_key_id, policy:data.policy, Signature:data.signature, key, 'x-oss-object-acl':data.x_oss_object_acl, 'x-oss-forbid-overwrite':data.x_oss_forbid_overwrite, success_action_status:'200' })) form.set(name,String(value));
    form.set('file', new Blob([new Uint8Array(await readFile(path))], {type:mimeType}), `input.${extension}`);
    const response = await fetch(host, {method:'POST',body:form,signal:AbortSignal.timeout(180_000)});
    if (!response.ok) throw new BadGatewayException('Could not upload the reference files to the character replacement provider.');
    return `oss://${key}`;
  }
  async create(imageUrl: string, videoUrl: string, mode: string) {
    const data = await this.request('/services/aigc/image2video/video-synthesis', {model:WAN_ANIMATE_MODEL,input:{image_url:imageUrl,video_url:videoUrl},parameters:{mode,check_image:true}});
    if (typeof data.output?.task_id !== 'string') throw new BadGatewayException('The provider did not return a task ID');
    return data.output.task_id as string;
  }
  async status(id: string): Promise<{ task_status: string; code?: string; results?: {video_url?: string} }> {
    const data = await this.request(`/tasks/${encodeURIComponent(id)}`);
    if (!data.output?.task_status) throw new BadGatewayException('The provider did not return a task status');
    return data.output;
  }
  async download(url: string) {
    const target = new URL(url);
    if (!['http:','https:'].includes(target.protocol) || !target.hostname.endsWith('.aliyuncs.com')) throw new BadGatewayException('Invalid result host');
    const response = await fetch(target, {signal:AbortSignal.timeout(180_000),redirect:'error'});
    if (!response.ok || !response.body) throw new BadGatewayException('Could not download the finished video');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 200*1024*1024) { await response.body.cancel().catch(()=>{}); throw new BadGatewayException('The generated video is too large'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
