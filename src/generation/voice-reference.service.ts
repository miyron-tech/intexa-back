import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WanVoiceClient } from './wan-voice.client.js';
import type { UsageReporter } from './billing.service.js';
const exec=promisify(execFile);
@Injectable()
export class VoiceReferenceService {
  constructor(private readonly provider:WanVoiceClient){}
  get enabled(){return this.provider.enabled;}
  get ready(){return this.provider.ready;}
  async prepare(dataUrl:string){
    const match=/^data:(audio\/(?:mpeg|mp3|wav|x-wav|wave|mp4|x-m4a|ogg|webm|aac));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
    if(!match)throw new BadRequestException('Upload an MP3, WAV, M4A, OGG or WebM voice sample');
    const buffer=Buffer.from(match[2],'base64');
    if(!buffer.length||buffer.length>5*1024*1024)throw new BadRequestException('Voice sample must be under 5 MB');
    const folder=await mkdtemp(join(tmpdir(),'voice-reference-'));
    try {
      const input=join(folder,'sample.bin');await writeFile(input,buffer);
      let data:{streams:{codec_type:string}[];format:{duration:string}};
      try {const {stdout}=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',input],{timeout:30_000,maxBuffer:1024*1024});data=JSON.parse(stdout);}catch{throw new BadRequestException('The voice sample is not a playable audio file');}
      const duration=Number(data.format.duration);
      if(!Number.isFinite(duration)||duration<2||duration>15||!data.streams.some(s=>s.codec_type==='audio')||data.streams.some(s=>s.codec_type==='video'))throw new BadRequestException('Use an audio-only voice sample between 2 and 15 seconds');
      const output=join(folder,'voice.mp3');
      await exec('ffmpeg',['-v','error','-protocol_whitelist','file,pipe','-i',input,'-map','0:a:0','-vn','-ar','44100','-ac','1','-c:a','libmp3lame','-b:a','96k',output],{timeout:60_000,maxBuffer:1024*1024});
      return {dataUrl:'data:audio/mpeg;base64,'+(await readFile(output)).toString('base64'),duration};
    } finally {await rm(folder,{recursive:true,force:true});}
  }
  async generate(voice:string,image:string|undefined,prompt:string,duration:number,resolution:string,ratio:string,report:UsageReporter,onCreated:(id:string)=>Promise<void>){
    const folder=await mkdtemp(join(tmpdir(),'voice-video-'));
    try {
      const path=join(folder,'voice.mp3');await writeFile(path,Buffer.from(voice.split(',')[1],'base64'));
      const audio=await this.provider.upload(path,'audio/mpeg','mp3');
      let photo:string|undefined;
      if(image){const imagePath=join(folder,'image.jpg');await writeFile(imagePath,Buffer.from(image.split(',')[1],'base64'));photo=await this.provider.upload(imagePath,'image/jpeg','jpg');}
      const id=await this.provider.create(prompt,audio,photo,duration,resolution,ratio);await onCreated(id);
      const deadline=Date.now()+20*60_000;
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,15_000));
        let status:Awaited<ReturnType<WanVoiceClient['status']>>;
        try {status=await this.provider.status(id);}catch(error){if(error instanceof HttpException && error.getStatus()>=500)continue;throw error;}
        if(status.task_status==='SUCCEEDED'){
          if(!status.video_url)throw new Error('The provider returned no voice-video file');
          await report(undefined,id); // Alibaba does not report the actual dollar charge here.
          return await this.provider.download(status.video_url);
        }
        if(['FAILED','CANCELED','UNKNOWN'].includes(status.task_status)){await report(undefined,id);if(status.code==='AccessDenied.Unpurchased')throw new Error('Voice-reference generation is not activated (AccessDenied.Unpurchased)');throw new Error('Voice-reference generation failed');}
      }
      throw new Error('Voice-reference generation timed out');
    } finally {await rm(folder,{recursive:true,force:true});}
  }
}
