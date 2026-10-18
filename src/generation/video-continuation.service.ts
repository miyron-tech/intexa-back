import { Injectable, BadRequestException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);

@Injectable()
export class VideoContinuationService {
  async inspect(path: string) {
    const { stdout } = await exec('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',path], {timeout:30_000,maxBuffer:1024*1024});
    const data = JSON.parse(stdout) as {streams:{codec_type:string;width?:number;height?:number}[];format:{duration:string}};
    const stream = data.streams.find(s=>s.codec_type==='video');
    const duration = Number(data.format.duration);
    if(!stream?.width || !stream.height || !Number.isFinite(duration) || duration<=0 || duration>120 || stream.width>4096 || stream.height>4096)
      throw new BadRequestException('Use a video up to 120 seconds and 4096 pixels per side');
    return {width:stream.width,height:stream.height,duration,audio:data.streams.some(s=>s.codec_type==='audio')};
  }
  async lastFrame(path: string) {
    const folder=await mkdtemp(join(tmpdir(),'video-frame-'));
    try {
      await exec('ffmpeg',['-v','error','-sseof','-1','-i',path,'-an','-vf','scale=1536:1536:force_original_aspect_ratio=decrease','-update','1','-q:v','2',join(folder,'frame.jpg')],{timeout:60_000});
      return 'data:image/jpeg;base64,'+(await readFile(join(folder,'frame.jpg'))).toString('base64');
    } finally {await rm(folder,{recursive:true,force:true});}
  }
  async trim(path: string, duration: number) {
    const folder=await mkdtemp(join(tmpdir(),'video-trim-'));
    try {
      const target=join(folder,'result.mp4');
      await exec('ffmpeg',['-v','error','-i',path,'-t',String(duration),'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',target],{timeout:300_000,maxBuffer:1024*1024});
      return {buffer:await readFile(target),...await this.inspect(target)};
    } finally {await rm(folder,{recursive:true,force:true});}
  }
  async combine(source: string, segment: Buffer) {
    const info=await this.inspect(source);
    const folder=await mkdtemp(join(tmpdir(),'video-continue-'));
    try {
      const next=join(folder,'segment.mp4');await writeFile(next,segment);
      const nextInfo=await this.inspect(next);
      if(info.duration+nextInfo.duration>120.1)throw new BadRequestException('The combined video must be at most 120 seconds');
      const width=Math.floor(info.width/2)*2,height=Math.floor(info.height/2)*2;
      for(const [i,path,media] of [[0,source,info],[1,next,nextInfo]] as const) {
        await exec('ffmpeg',['-v','error','-i',path,...(media.audio?[]:['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']),'-map','0:v:0','-map',media.audio?'0:a:0':'1:a:0','-vf',`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=24`,'-af','aresample=48000,asetpts=PTS-STARTPTS','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-t',String(media.duration),'-video_track_timescale','12288',join(folder,`${i}.mp4`)],{timeout:300_000,maxBuffer:1024*1024});
      }
      await writeFile(join(folder,'list.txt'),"file '0.mp4'\nfile '1.mp4'\n");
      await exec('ffmpeg',['-v','error','-f','concat','-safe','1','-i',join(folder,'list.txt'),'-c','copy','-movflags','+faststart',join(folder,'result.mp4')],{timeout:60_000});
      const result=await this.inspect(join(folder,'result.mp4'));
      return {buffer:await readFile(join(folder,'result.mp4')),width,height,duration:result.duration};
    } finally {await rm(folder,{recursive:true,force:true});}
  }
}
