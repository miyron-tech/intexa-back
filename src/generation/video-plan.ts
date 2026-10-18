import { BadRequestException } from '@nestjs/common';
export const LONG_VIDEO_DURATIONS = Array.from({length:59},(_,index)=>index+2);
/** The model creates supported chunks; the last chunk is trimmed to the requested length. */
export function planVideo(duration: number, allowed: number[]): number[] {
  if(!Number.isInteger(duration) || duration<2 || duration>60 || !allowed.length)throw new BadRequestException('Choose a video length between 2 and 60 seconds');
  const limit=duration+Math.max(...allowed);
  const plans: (number[] | undefined)[] = Array(limit+1);plans[0]=[];
  for(let total=1;total<=limit;total++)for(const part of [...allowed].sort((a,b)=>b-a)) {
    const previous=plans[total-part];
    if(previous && (!plans[total] || previous.length+1<plans[total]!.length))plans[total]=[...previous,part];
  }
  for(let total=duration;total<=limit;total++)if(plans[total])return plans[total]!.sort((a,b)=>b-a);
  throw new BadRequestException('Unsupported duration for this quality');
}
