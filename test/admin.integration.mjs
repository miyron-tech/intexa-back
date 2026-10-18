import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const accounts=JSON.parse(await readFile(process.argv[2],'utf8'));
const admin=accounts.find(a=>a.role==='admin'), user=accounts.find(a=>a.role==='user');
async function call(path,method='GET',body,token){const r=await fetch('http://localhost:4100'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:r.status===204?null:await r.json()}}
const a=(await call('/auth/login','POST',{email:admin.email,password:admin.password})).data.tokens.accessToken;
const u=(await call('/auth/login','POST',{email:user.email,password:user.password})).data.tokens.accessToken;
assert.equal((await call('/admin/users')).status,401);
for(const path of ['/admin/users','/admin/top-ups','/admin/plans','/admin/summary'])assert.equal((await call(path,'GET',undefined,u)).status,403);
assert.equal((await call('/admin/plans/creator','PATCH',{monthlyCents:1,annualMonthlyCents:1,credits:1,version:1},u)).status,403);
const users=await call(`/admin/users?q=${encodeURIComponent(user.email)}`,'GET',undefined,a);assert.equal(users.status,200);assert.equal(users.data.total,1);assert(!JSON.stringify(users.data).includes('password'));
const plan=(await call('/plans')).data.find(p=>p.id==='creator');const requestId=randomUUID();let changed=false;
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{
 const update={monthlyCents:plan.monthlyCents+100,annualMonthlyCents:plan.annualMonthlyCents,credits:plan.credits,version:plan.version};
 assert.equal((await call('/admin/plans/creator','PATCH',update,a)).status,200);changed=true;
 assert.equal((await call('/plans')).data.find(p=>p.id==='creator').monthlyCents,update.monthlyCents);
 assert.equal((await call('/admin/plans/creator','PATCH',update,a)).status,409);
 assert.equal((await call('/admin/plans/creator','PATCH',{...update,monthlyCents:-1},a)).status,400);
 const payload={requestId,email:user.email,amountCents:1900,credits:1000,note:'AUTOMATED TEST — no real payment. Removed after validation.'};
 assert.equal((await call('/admin/top-ups','POST',payload,u)).status,403);
 const results=await Promise.all([call('/admin/top-ups','POST',payload,a),call('/admin/top-ups','POST',payload,a)]);
 results.forEach(r=>assert.equal(r.status,201,JSON.stringify(r.data)));assert.equal(results[1].data.id,results[0].data.id);
 assert.equal((await call('/auth/me','GET',undefined,u)).data.creditBalance,users.data.rows[0].creditBalance+1000);
 assert.equal((await call('/admin/top-ups','POST',{...payload,credits:2000},a)).status,409);
 assert.equal((await call('/admin/top-ups','POST',{...payload,requestId:randomUUID(),amountCents:0.5},a)).status,400);
 assert.equal((await db.query('SELECT count(*)::int AS total FROM top_ups WHERE request_id=$1',[requestId])).rows[0].total,1);
 assert.equal((await db.query("SELECT count(*)::int AS total FROM admin_audit WHERE target_id=$1 AND action='topup.create'",[results[0].data.id])).rows[0].total,1);
 console.log('PASS: role protection, user search, public plan update, stale update rejection, amount validation, concurrent idempotency, balance and audit.');
}finally{
 if(changed){const current=(await call('/plans')).data.find(p=>p.id==='creator');assert.equal(current.version,plan.version+1);assert.equal((await call('/admin/plans/creator','PATCH',{monthlyCents:plan.monthlyCents,annualMonthlyCents:plan.annualMonthlyCents,credits:plan.credits,version:current.version},a)).status,200)}
 const found=(await db.query('SELECT id,user_id,credits,amount_cents FROM top_ups WHERE request_id=$1',[requestId])).rows[0];
 if(found){await db.query('BEGIN');try{await db.query('DELETE FROM admin_audit WHERE target_id=$1',[found.id]);await db.query('DELETE FROM top_ups WHERE id=$1',[found.id]);await db.query('UPDATE users SET credit_balance=credit_balance-$2,credit_value_usd=credit_value_usd-$3::numeric/100 WHERE id=$1',[found.user_id,found.credits,found.amount_cents]);await db.query('COMMIT')}catch(e){await db.query('ROLLBACK');throw e}}
 await db.end();console.log('Test financial data removed; public prices restored.');
}
