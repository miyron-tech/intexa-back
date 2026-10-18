import { Body, Controller, Get, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsUUID, Max, Min } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AccessTokenPayload } from '../auth/auth.types.js';
import { CharacterSwapService, type MediaFile, type SwapMode } from './character-swap.service.js';
import { JobRunnerService } from './job-runner.service.js';
import { toJobResponse } from './generation.controller.js';
class SwapDto {
  @IsUUID() requestId:string;
  @IsIn(['wan-std','wan-pro']) mode:SwapMode;
  @Type(()=>Number) @IsInt() @Min(1) @Max(100000) expectedCredits:number;
  @Transform(({value})=>value==='true') @IsBoolean() consent:boolean;
}
@Controller('generation/character-swap')
export class CharacterSwapController {
  constructor(private readonly swap:CharacterSwapService,private readonly runner:JobRunnerService) {}
  @Get('config') settings() { return this.swap.settings(); }
  @Post() @Throttle({default:{limit:3,ttl:60000}})
  @UseInterceptors(FileFieldsInterceptor([{name:'video',maxCount:1},{name:'image',maxCount:1}],{limits:{fileSize:50*1024*1024,files:2,fields:4,fieldSize:1024}}))
  async create(@CurrentUser() user:AccessTokenPayload,@Body() dto:SwapDto,@UploadedFiles() files:{video?:MediaFile[];image?:MediaFile[]}) {
    const {job,created}=await this.swap.create(user.sub,dto,files?.video?.[0],files?.image?.[0]);
    if(created)this.runner.enqueue(job.id);
    return toJobResponse(job);
  }
}
