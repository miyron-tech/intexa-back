import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import {DataSource} from 'typeorm';
import {ConfigService} from '@nestjs/config';
import {buildDataSourceOptions} from '../dist/database/data-source.js';
import {GenerationJob} from '../dist/generation/entities/generation-job.entity.js';
import {BillingService} from '../dist/generation/billing.service.js';
import {StorageService} from '../dist/generation/storage.service.js';
import {CharacterSwapService} from '../dist/generation/character-swap.service.js';
import {WanAnimateClient} from '../dist/generation/wan-animate.client.js';
import {JobRunnerService} from '../dist/generation/job-runner.service.js';
import {toJobResponse} from '../dist/generation/generation.controller.js';
const schema='swap_test_'+randomUUID().replaceAll('-',''),folder=await mkdtemp(join(tmpdir(),'swap-test-'));
const control=new pg.Client({connectionString:process.env.DATABASE_URL});await control.connect();await control.query(`CREATE SCHEMA "${schema}"`);
const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new DataSource({...buildDataSourceOptions(url.toString()),schema});
const originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout;
try{
 await db.initialize();await db.runMigrations();
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x240:r=25','-t','2','-c:v','libx264','-pix_fmt','yuv420p',join(folder,'sample.mp4')]);
 const video={buffer:await readFile(join(folder,'sample.mp4')),mimetype:'video/mp4'};video.size=video.buffer.length;
 const image={buffer:await sharp({create:{width:320,height:320,channels:3,background:'#a0a080'}}).jpeg().toBuffer(),mimetype:'image/jpeg'};image.size=image.buffer.length;
 const [user]=await db.query("INSERT INTO users(email,password_hash,credit_balance,credit_value_usd) VALUES('swap@example.invalid','not-a-login',1000,20) RETURNING id");
 const config=new ConfigService({STORAGE_DIR:folder,DASHSCOPE_API_KEY:'test-key'}),storage=new StorageService(config),billing=new BillingService(db),repo=db.getRepository(GenerationJob);
 let failure=false;
 const wan={enabled:true,upload:async()=> 'oss://test/file',create:async()=>randomUUID(),status:async()=>failure?{task_status:'FAILED'}:{task_status:'SUCCEEDED',results:{video_url:'https://results.oss.aliyuncs.com/test.mp4'}},download:async()=>video.buffer};
 const swap=new CharacterSwapService(repo,billing,storage,wan);
 const dto={requestId:randomUUID(),mode:'wan-std',expectedCredits:40,consent:true};
 await assert.rejects(swap.create(user.id,{...dto,consent:false},video,image),/permission/);
 await assert.rejects(swap.create(user.id,{...dto,expectedCredits:1},video,image),/40 credits/);
 await assert.rejects(swap.inspectVideo(Buffer.from('not a movie')),/playable/);
 await assert.rejects(swap.create(user.id,dto,video,{...image,buffer:Buffer.from('not an image')}),/JPEG/);
 const disabled=new CharacterSwapService(repo,billing,storage,{enabled:false});
 await assert.rejects(disabled.create(user.id,dto,video,image),/not connected/);
 const results=await Promise.all([swap.create(user.id,dto,video,image),swap.create(user.id,dto,video,image)]);
 assert.equal(results[0].job.id,results[1].job.id);assert.equal(results.filter(x=>x.created).length,1);
 const job=results[0].job;
 assert.equal((await db.query('SELECT credit_balance FROM users WHERE id=$1',[user.id]))[0].credit_balance,960);
 assert.equal(toJobResponse(job).params.sourceVideoPath,undefined);
 assert.equal(toJobResponse(job).params.referenceImagePath,undefined);
 await assert.rejects(swap.create(user.id,{...dto,mode:'wan-pro',expectedCredits:60},video,image),/different files/);
 globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===15000?0:ms,...args);
 await swap.run(job);
 let finished=await repo.findOneByOrFail({id:job.id});assert.equal(finished.status,'succeeded');assert.equal(finished.creditsCharged,40);assert.equal(finished.outputs.length,1);
 assert.equal((await readFile(storage.absolute(finished.outputs[0].path))).length,video.buffer.length);
 await assert.rejects(readFile(storage.absolute(job.params.sourceVideoPath)),/ENOENT/);
 failure=true;
 const failed=await swap.create(user.id,{...dto,requestId:randomUUID()},video,image);
 const runner=new JobRunnerService(repo,{},storage,{},config,billing,swap);runner.enqueue(failed.job.id);
 for(let i=0;i<100;i++){const latest=await repo.findOneBy({id:failed.job.id});if(latest.status==='failed')break;await new Promise(resolve=>originalTimer(resolve,20));}
 finished=await repo.findOneByOrFail({id:failed.job.id});assert.equal(finished.status,'failed');assert.equal(finished.billingStatus,'refunded');
 assert.equal((await db.query('SELECT credit_balance FROM users WHERE id=$1',[user.id]))[0].credit_balance,960);
 // Exercise the provider contract without a real charge or API key.
 let policy=false,uploaded=false,created=false;
 globalThis.fetch=async(target,init={})=>{
  const address=String(target);
  if(address.includes('/uploads?')){policy=true;return Response.json({data:{upload_host:'https://test.oss.aliyuncs.com',upload_dir:'test',policy:'policy',signature:'sig',oss_access_key_id:'id',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});}
  if(address==='https://test.oss.aliyuncs.com/'){uploaded=true;assert(!init.headers?.authorization);assert.equal([...init.body.keys()].at(-1),'file');return new Response('');}
  if(address.endsWith('/video-synthesis')){created=true;const body=JSON.parse(init.body);assert.equal(body.model,'wan2.2-animate-mix');assert.equal(body.parameters.mode,'wan-std');assert.equal(init.headers['X-DashScope-OssResourceResolve'],'enable');return Response.json({output:{task_id:'provider-test'}});}
  if(address.endsWith('/tasks/provider-test'))return Response.json({output:{task_status:'SUCCEEDED',results:{video_url:'https://test.oss.aliyuncs.com/out.mp4'}}});
  throw Error('Unexpected provider URL');
 };
 const client=new WanAnimateClient(config),uploadedUrl=await client.upload(join(folder,'sample.mp4'),'video/mp4','mp4');
 assert(uploadedUrl.startsWith('oss://test/'));assert.equal(await client.create(uploadedUrl,uploadedUrl,'wan-std'),'provider-test');assert.equal((await client.status('provider-test')).task_status,'SUCCEEDED');assert(policy&&uploaded&&created);
  await assert.rejects(client.download('https://example.com/result.mp4'),/Invalid result host/);
  globalThis.fetch=async()=>Response.json({code:'AccessDenied.Unpurchased'},{status:403});
  await assert.rejects(client.create(uploadedUrl,uploadedUrl,'wan-std'),/not activated/);
  assert.match(toJobResponse({...job,error:'AccessDenied.Unpurchased'}).error,/awaiting service activation/);
 console.log('PASS: real video validation, file formats, consent, exact price, duplicate requests, private source paths, saved video, source cleanup, automatic refund and Alibaba upload/task contract');
}finally{
 globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimer;
 if(db.isInitialized)await db.destroy();await control.query(`DROP SCHEMA "${schema}" CASCADE`);await control.end();await rm(folder,{recursive:true,force:true});
}
