import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';import {DataSource} from 'typeorm';import {ConfigService} from '@nestjs/config';
import {buildDataSourceOptions} from '../dist/database/data-source.js';
import {GenerationJob} from '../dist/generation/entities/generation-job.entity.js';
import {BillingService} from '../dist/generation/billing.service.js';import {StorageService} from '../dist/generation/storage.service.js';
import {ImageService} from '../dist/generation/image.service.js';import {GenerationController,toJobResponse} from '../dist/generation/generation.controller.js';
import {JobRunnerService} from '../dist/generation/job-runner.service.js';import {VideoContinuationService} from '../dist/generation/video-continuation.service.js';
import {VoiceReferenceService} from '../dist/generation/voice-reference.service.js';import {WanVoiceClient} from '../dist/generation/wan-voice.client.js';
const schema='voice_test_'+randomUUID().replaceAll('-',''),folder=await mkdtemp(join(tmpdir(),'voice-test-'));
const control=new pg.Client({connectionString:process.env.DATABASE_URL});await control.connect();await control.query(`CREATE SCHEMA "${schema}"`);
const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new DataSource({...buildDataSourceOptions(url.toString()),schema});const originalFetch=globalThis.fetch,timer=globalThis.setTimeout;
try{
 await db.initialize();await db.runMigrations();const exec=promisify(execFile);
 for(const duration of [3,16])await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t',String(duration),join(folder,`voice-${duration}.wav`)]);
 await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x240:r=24','-t','2','-c:v','libx264','-pix_fmt','yuv420p',join(folder,'clip.mp4')]);
 const sample='data:audio/wav;base64,'+(await readFile(join(folder,'voice-3.wav'))).toString('base64');
 const config=new ConfigService({STORAGE_DIR:folder}),storage=new StorageService(config),media=new VideoContinuationService(),repo=db.getRepository(GenerationJob),billing=new BillingService(db);
 let calls=0,fail=false;
 const provider={enabled:true,ready:true,upload:async(path,mime)=>{assert.equal(mime,'audio/mpeg');return 'oss://private/audio.mp3';},create:async(prompt,audio,image,duration)=>{calls++;assert.equal(audio,'oss://private/audio.mp3');assert.equal(duration,2);if(fail)throw Error('AccessDenied.Unpurchased');return 'voice-task';},status:async()=>({task_status:'SUCCEEDED',video_url:'https://result.oss.aliyuncs.com/video.mp4'}),download:async()=>await readFile(join(folder,'clip.mp4'))};
 const voice=new VoiceReferenceService(provider);
 assert((await voice.prepare(sample)).dataUrl.startsWith('data:audio/mpeg;base64,'));
 await assert.rejects(voice.prepare('data:audio/wav;base64,bm90IGF1ZGlv'),/playable/);
 await assert.rejects(voice.prepare('data:audio/wav;base64,'+(await readFile(join(folder,'voice-16.wav'))).toString('base64')),/2 and 15/);
 const [user]=await db.query("INSERT INTO users(email,password_hash,credit_balance,credit_value_usd) VALUES('voice@example.invalid','not-a-login',1000,20) RETURNING id");
 const controller=new GenerationController(repo,{enqueue(){}},storage,new ImageService(),billing,media,voice);
 const dto={service:'video_ad',preset:'custom',requestId:randomUUID(),description:'Say hello in the reference voice',videoModel:'standard',duration:2,expectedCredits:40,voiceReference:sample};
 const disabled=new GenerationController(repo,{enqueue(){}},storage,new ImageService(),billing,media,new VoiceReferenceService({...provider,ready:false}));
 await assert.rejects(disabled.create({sub:user.id},dto),/activation/);assert.equal((await db.query('SELECT credit_balance FROM users WHERE id=$1',[user.id]))[0].credit_balance,1000);
 await assert.rejects(controller.create({sub:user.id},{...dto,videoModel:'premium',expectedCredits:100}),/Draft and Standard/);
 const job=await controller.create({sub:user.id},dto);const duplicate=await controller.create({sub:user.id},dto);assert.equal(job.id,duplicate.id);assert.equal(job.params.voiceReference,undefined);assert.equal(job.params.hasVoiceReference,true);
 const retry=await controller.retry({sub:user.id},job.id);assert(retry.params.voiceReference.startsWith('data:audio/mpeg'));await assert.rejects(controller.retry({sub:randomUUID()},job.id),/not found/);
 globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000?0:ms,...args);
 const runner=new JobRunnerService(repo,{createVideo:async()=>{throw Error('Voice must never be silently sent as ordinary OpenRouter video');}},storage,new ImageService(),config,billing,undefined,media,voice);
 await runner.run(job.id);let finished=await repo.findOneByOrFail({id:job.id});assert.equal(finished.status,'succeeded');assert.equal(finished.creditsCharged,40);assert.equal(calls,1);assert.equal(finished.model,'wan3.0-video');
 assert.equal(toJobResponse(finished).params.voiceReference,undefined);assert.equal((await db.query("SELECT count(*)::int AS n FROM generation_usage WHERE job_id=$1 AND cost_usd IS NULL",[job.id]))[0].n,1);
 fail=true;const failed=await controller.create({sub:user.id},{...dto,requestId:randomUUID()});await runner.run(failed.id);finished=await repo.findOneByOrFail({id:failed.id});assert.equal(finished.billingStatus,'refunded');assert(toJobResponse(finished).error.includes('activation'));assert.equal((await db.query('SELECT credit_balance FROM users WHERE id=$1',[user.id]))[0].credit_balance,960);
 // Verify actual Alibaba JSON contract and that API authorization is never sent to OSS uploads.
 let uploaded=false,created=false;
 globalThis.fetch=async(target,init={})=>{
  const address=String(target);
  if(address.includes('/uploads?')){assert(address.includes('wan3.0-video'));return Response.json({data:{upload_host:'https://test.oss.aliyuncs.com',upload_dir:'test',policy:'policy',signature:'sig',oss_access_key_id:'id',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});}
  if(address==='https://test.oss.aliyuncs.com/'){uploaded=true;assert(!init.headers?.authorization);return new Response('');}
  if(address.endsWith('/video-synthesis')){created=true;const body=JSON.parse(init.body);assert.equal(body.model,'wan3.0-video');assert.deepEqual(body.input.media.map(m=>m.type),['reference_image','reference_audio']);assert(body.input.prompt.includes('Audio 1'));assert.equal(body.parameters.resolution,'720P');assert(!JSON.stringify(body).includes('first_frame'));return Response.json({output:{task_id:'contract'}});}
  if(address.endsWith('/tasks/contract'))return Response.json({output:{task_status:'SUCCEEDED',video_url:'https://test.oss.aliyuncs.com/result.mp4'}});
  throw Error('Unexpected URL');
 };
 const client=new WanVoiceClient(new ConfigService({DASHSCOPE_API_KEY:'not-a-real-key',DASHSCOPE_VOICE_ENABLED:true}));assert(client.ready);
 const uploadedUrl=await client.upload(join(folder,'voice-3.wav'),'audio/wav','wav');assert(uploadedUrl.startsWith('oss://'));assert.equal(await client.create('Hello',uploadedUrl,'oss://image.jpg',2,'720p','9:16'),'contract');assert.equal((await client.status('contract')).task_status,'SUCCEEDED');assert(uploaded&&created);
 console.log('PASS: audio validation/normalization, activation guard before billing, idempotency, private audio/owned retry, real runner routing to Wan, refund, unknown provider costs and image+audio API contract. No paid calls.');
}finally{globalThis.fetch=originalFetch;globalThis.setTimeout=timer;await db.destroy();await control.query(`DROP SCHEMA "${schema}" CASCADE`);await control.end();await rm(folder,{recursive:true,force:true});}
