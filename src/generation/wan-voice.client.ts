import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WanAnimateClient } from './wan-animate.client.js';

@Injectable()
export class WanVoiceClient {
  readonly model='wan3.0-video';
  constructor(private readonly config: ConfigService) {}
  get enabled(){return Boolean(this.config.get<string>('DASHSCOPE_VOICE_API_KEY') || this.config.get<string>('DASHSCOPE_API_KEY'));}
  get ready(){return this.enabled && (this.config.get('DASHSCOPE_VOICE_ENABLED')===true || this.config.get('DASHSCOPE_VOICE_ENABLED')==='true');}
  private get key(){return this.config.get<string>('DASHSCOPE_VOICE_API_KEY') || this.config.get<string>('DASHSCOPE_API_KEY');}
  private get base(){return (this.config.get<string>('DASHSCOPE_VOICE_BASE_URL') || this.config.get<string>('DASHSCOPE_BASE_URL') || 'https://dashscope-intl.aliyuncs.com/api/v1').replace(/\/$/,'');}
  private get files(){return new WanAnimateClient(new ConfigService({DASHSCOPE_API_KEY:this.key,DASHSCOPE_BASE_URL:this.base}));}
  upload(path:string,mime:string,extension:string){return this.files.upload(path,mime,extension,this.model);}
  download(url:string){return this.files.download(url);}
  private async request(path:string,body?:unknown){
    if(!this.enabled)throw new ServiceUnavailableException('Voice references are not connected.');
    let response:Response;
    try {response=await fetch(this.base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${this.key}`,'content-type':'application/json','X-DashScope-Async':'enable','X-DashScope-OssResourceResolve':'enable'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60_000)});}catch{throw new BadGatewayException('Could not reach the voice-reference provider');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok || data.code){
      if(data.code==='AccessDenied.Unpurchased')throw new ServiceUnavailableException('Voice-reference generation is not activated in the provider account (AccessDenied.Unpurchased).');
      if(response.status===401||response.status===403)throw new ServiceUnavailableException('Voice-reference provider access is unavailable. Check the model and region activation.');
      throw new BadGatewayException('The voice-reference provider could not process this request');
    }
    return data;
  }
  async create(prompt:string,audio:string,image:string|undefined,duration:number,resolution:string,ratio:string){
    const media=[...(image?[{type:'reference_image',url:image}]:[]),{type:'reference_audio',url:audio}];
    const instruction='Extract the voice characteristics and vocal identity from Audio 1. Use that voice for the quoted dialogue in the user prompt, in its original language, with synchronized lip movements. Do not repeat the words from the sample unless they occur in the user dialogue. '+(image?'Keep the character appearance from Image 1. ':'');
    const data=await this.request('/services/aigc/video-generation/video-synthesis',{model:this.model,input:{prompt:instruction+prompt,media},parameters:{duration,resolution:resolution.toUpperCase(),ratio,prompt_extend:false}});
    if(typeof data.output?.task_id!=='string')throw new BadGatewayException('The provider did not return a voice-video task ID');
    return data.output.task_id as string;
  }
  async status(id:string):Promise<{task_status:string;video_url?:string;code?:string;message?:string}>{
    const data=await this.request(`/tasks/${encodeURIComponent(id)}`);
    if(typeof data.output?.task_status!=='string')throw new BadGatewayException('The provider did not return a voice-video status');
    return data.output;
  }
}
