import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { GenerationJob } from './entities/generation-job.entity.js';
import { BillingService } from './billing.service.js';
import { StorageService } from './storage.service.js';
import { WAN_ANIMATE_MODEL, WanAnimateClient } from './wan-animate.client.js';

export type SwapMode = 'wan-std' | 'wan-pro';
export interface MediaFile { buffer: Buffer; size: number; mimetype: string; }
export const SWAP_RATES: Record<SwapMode,number> = { 'wan-std':20, 'wan-pro':30 };
const exec = promisify(execFile);
@Injectable()
export class CharacterSwapService {
  constructor(@InjectRepository(GenerationJob) private readonly jobs: Repository<GenerationJob>, private readonly billing: BillingService, private readonly storage: StorageService, private readonly wan: WanAnimateClient) {}
  settings() { return {enabled:this.wan.enabled,minSeconds:2,maxSeconds:30,maxVideoBytes:50*1024*1024,maxImageBytes:5*1024*1024,rates:SWAP_RATES}; }
  async inspectVideo(buffer: Buffer) {
    const folder = await mkdtemp(join(tmpdir(),'intexa-video-'));
    try {
      const path = join(folder,'input.mp4'); await writeFile(path,buffer);
      const {stdout} = await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','stream=codec_type,width,height:format=duration,format_name','-of','json',path],{timeout:20_000,maxBuffer:65536});
      const data = JSON.parse(stdout); const video = data.streams?.find((s:{codec_type:string})=>s.codec_type==='video');
      const duration = Number(data.format?.duration);
      if (!video || !Number.isFinite(duration) || duration < 2 || duration > 30 || !/(mp4|mov)/.test(data.format?.format_name ?? '') || video.width < 200 || video.height < 200 || video.width > 2048 || video.height > 2048 || video.width/video.height > 3 || video.height/video.width > 3) throw new Error('Unsupported video');
      return duration;
    } catch { throw new BadRequestException('Use a playable MP4 or MOV video, 2–30 seconds, 200–2048 pixels per side, with aspect ratio between 1:3 and 3:1.'); }
    finally { await rm(folder,{recursive:true,force:true}); }
  }
  async create(userId:string, dto:{requestId:string;mode:SwapMode;expectedCredits:number;consent:boolean}, video?:MediaFile, image?:MediaFile) {
    if (!this.wan.enabled) throw new ServiceUnavailableException('Character replacement is not connected yet. No credits have been charged.');
    if (!dto.consent) throw new BadRequestException('Confirm you have permission to use both the video and the character photo.');
    if (!video?.buffer.length || !image?.buffer.length) throw new BadRequestException('Upload a video and a character photo.');
    if (video.buffer.length > this.settings().maxVideoBytes || image.buffer.length > this.settings().maxImageBytes) throw new BadRequestException('The video must be under 50 MB and the photo under 5 MB.');
    if (!Object.hasOwn(SWAP_RATES,dto.mode)) throw new BadRequestException('Unknown quality option');
    const duration = await this.inspectVideo(video.buffer);
    const credits = Math.ceil(duration)*SWAP_RATES[dto.mode];
    if (credits !== dto.expectedCredits) throw new BadRequestException(`The measured video needs ${credits} credits. Re-select the video to update the estimate.`);
    let normalized:Buffer;
    try {
      const metadata = await sharp(image.buffer,{limitInputPixels:4096*4096}).metadata();
      const w=metadata.width ?? 0,h=metadata.height ?? 0;
      if (!['jpeg','png','webp'].includes(metadata.format ?? '') || w < 200 || h < 200 || w > 4096 || h > 4096 || w/h > 3 || h/w > 3) throw new Error('Invalid photo');
      normalized = await sharp(image.buffer).rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
    } catch { throw new BadRequestException('Use a JPEG, PNG or WebP photo, 200–4096 pixels per side, showing one clear character.'); }
    const hash = createHash('sha256').update(JSON.stringify({mode:dto.mode,consent:dto.consent,expectedCredits:dto.expectedCredits})).update(video.buffer).update(image.buffer).digest('hex');
    const previous = await this.jobs.findOneBy({userId,requestId:dto.requestId});
    if (previous) {
      if (previous.requestHash !== hash) throw new BadRequestException('This request was already used with different files. Reload the page.');
      return {job:previous,created:false};
    }
    const assetId = randomUUID();
    try {
      const videoPath = await this.storage.save(userId,assetId,'source.mp4',video.buffer);
      const imagePath = await this.storage.save(userId,assetId,'character.jpg',normalized);
      const result = await this.billing.reserve(userId,dto.requestId,hash,credits,{service:'character_swap',preset:dto.mode,status:'queued',outputs:[],params:{sourceVideoPath:videoPath,referenceImagePath:imagePath,assetId,duration,mode:dto.mode}});
      if (!result.created) await this.storage.removeJob(userId,assetId);
      return result;
    } catch(error) { await this.storage.removeJob(userId,assetId);throw error; }
  }
  async run(job:GenerationJob) {
    const p = job.params as {sourceVideoPath:string;referenceImagePath:string;mode:SwapMode;assetId:string};
    try {
      await this.jobs.update(job.id,{model:WAN_ANIMATE_MODEL,prompt:`Replace the main character, preserving the source performance and environment (${p.mode}).`});
      const report = await this.billing.startUsage(job.id,'video',WAN_ANIMATE_MODEL,`Character replacement (${p.mode})`);
      const [image,video] = await Promise.all([
        this.wan.upload(this.storage.absolute(p.referenceImagePath),'image/jpeg','jpg'),
        this.wan.upload(this.storage.absolute(p.sourceVideoPath),'video/mp4','mp4'),
      ]);
      const id = await this.wan.create(image,video,p.mode);await this.jobs.update(job.id,{remoteId:id});
      const deadline = Date.now()+20*60_000;
      while(Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,15_000));
        const result = await this.wan.status(id);
        if (result.task_status === 'SUCCEEDED') {
          await report(undefined,id); // Duration is reported by DashScope; dollar cost is not inferred.
          if (!result.results?.video_url) throw new Error('The provider returned no video');
          const buffer = await this.wan.download(result.results.video_url);
          const path = await this.storage.save(job.userId,job.id,'0.mp4',buffer);
          await this.billing.finish(job.id,true,[{path,mimeType:'video/mp4',bytes:buffer.length}]);return;
        }
        if (['FAILED','CANCELED','UNKNOWN'].includes(result.task_status)) { await report(undefined,id);const code=typeof result.code==='string'?result.code.replace(/[^a-zA-Z0-9._-]/g,'').slice(0,100):result.task_status;throw new Error(`Character replacement did not complete (${code}). Try a clip with one clearly visible person.`); }
      }
      throw new Error('Character replacement timed out');
    } finally { await this.storage.removeJob(job.userId,p.assetId); }
  }
}
