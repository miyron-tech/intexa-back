import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { deploymentGate } from '../dist/deployment-gate.js';
const folder=mkdtempSync(join(tmpdir(),'deployment-gate-'));
const gate=deploymentGate(folder);
function call(method,path) {
 const res=new EventEmitter();res.statusCode=200;
 res.setHeader=()=>{};res.status=(s)=>{res.statusCode=s;return res};res.json=(v)=>{res.body=v};
 let next=false;gate({method,path},res,()=>{next=true});return {res,next};
}
try {
 const first=call('POST','/generation/jobs');assert(first.next);
 assert.equal(call('GET','/health/deployment').res.body.inFlight,1);
 writeFileSync(join(folder,'.deployment-blocked'),'');
 for(const path of ['/generation/jobs','/generation/jobs/id/extend','/generation/character-swap']){
  const blocked=call('POST',path);assert(!blocked.next);assert.equal(blocked.res.statusCode,503);
 }
 assert(call('POST','/payments/webhook').next);assert(call('GET','/generation/jobs/id').next);
 first.res.emit('finish');first.res.emit('finish');
 assert.deepEqual(call('GET','/health/deployment').res.body,{blocked:true,inFlight:0});
 rmSync(join(folder,'.deployment-blocked'));
 const resumed=call('POST','/generation/jobs');assert(resumed.next);resumed.res.emit('finish');
 console.log('Deployment gate integration checks passed');
} finally {rmSync(folder,{recursive:true,force:true})}
