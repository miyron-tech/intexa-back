import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../dist/database/data-source.js';
import { PaymentsService, validSignature } from '../dist/payments/payments.service.js';
import { PaymentsController } from '../dist/payments/payments.controller.js';
import { Module, ValidationPipe } from '@nestjs/common';
import { CUSTOM_PACKAGE, quoteCustomPackage } from '../dist/payments/custom-package.js';
import { NestFactory } from '@nestjs/core';
const schema = `payments_test_${randomUUID().replaceAll('-', '')}`;
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
await control.connect();
await control.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new DataSource({ ...buildDataSourceOptions(url.toString()), schema });
const originalFetch = globalThis.fetch;
let app;
try {
  await db.initialize(); await db.runMigrations();
  const [user] = await db.query("INSERT INTO users(email,password_hash) VALUES('payments-test@example.invalid','not-a-login-hash') RETURNING id");
  const config = { get: name => ({ WEMOPAY_API_KEY: 'test-key', WEMOPAY_SIGNING_KEY: 'test-signing-key', WEMOPAY_API_URL: 'https://provider.invalid/api', FRONTEND_URL: 'https://intexa-ai.com' })[name] };
  const service = new PaymentsService(db, config);
  assert.equal(await service.profile(user.id), null);
  class TestModule {}
  Module({controllers:[PaymentsController],providers:[{provide:PaymentsService,useValue:service}]})(TestModule);
  app = await NestFactory.create(TestModule, {logger:false});
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
  app.use((req,res,next) => { req.user={sub:user.id};next(); });
  await app.listen(0,'127.0.0.1');
  const profileUrl = (await app.getUrl())+'/payments/billing-profile';
  assert.deepEqual(await (await originalFetch(profileUrl)).json(), {details:null}, 'New accounts must receive valid JSON');
  let outgoing;
  const providerId = randomUUID();
  globalThis.fetch = async (_url, init) => { outgoing = JSON.parse(init.body); return Response.json({ result: { id: providerId, redirectUrl: 'https://provider.invalid/pay' } }); };
  const details = { email:'payment@example.com',firstName:'Test',lastName:'Customer',addressLine1:'1 Test Street',city:'London',countryCode:'GB',postalCode:'SW1A 1AA' };
  await assert.rejects(service.checkout(user.id, 'creator', {...details,email:'account@test.local'}), /valid payment email/);
  assert.equal((await service.list(user.id)).length,0,'Invalid email should not create a pending payment');
  const order = await service.checkout(user.id, 'creator', details);
  assert.equal(outgoing.amount, 19); assert.equal(outgoing.currency, 'USD');
  assert.equal(outgoing.referenceId, order.id);
  assert.deepEqual(outgoing.customer, { email: 'payment@example.com', firstName: 'Test', lastName: 'Customer' });
  assert.equal((await db.query('SELECT email FROM users WHERE id=$1',[user.id]))[0].email,'payments-test@example.invalid','Billing email must not change sign-in email');
  assert.equal(outgoing.billingAddress.postalCode, 'SW1A 1AA');
  assert.deepEqual(await new PaymentsService(db, config).profile(user.id), details);
  assert.deepEqual(await (await originalFetch(profileUrl)).json(), {details}, 'Saved profile must be returned over HTTP');
  assert.equal(await service.profile(randomUUID()), null, 'Another account must not see saved billing details');
  assert.equal(outgoing.webhookUrl, 'https://intexa-ai.com/api/payments/wemopay/webhook');
  await assert.rejects(service.checkout(user.id, 'explorer'), /paid credit package/);
  const deliver = (changes = {}, signature) => {
    const body = Buffer.from(JSON.stringify({ id: providerId, referenceId: order.id, paymentType: 'DEPOSIT', state: 'COMPLETED', amount: 19, currency: 'USD', ...changes }));
    return service.webhook(body, signature ?? createHmac('sha256', 'test-signing-key').update(body).digest('hex'));
  };
  const balance = async () => (await db.query('SELECT credit_balance AS credits,credit_value_usd::float8 AS value FROM users WHERE id=$1', [user.id]))[0];
  await assert.rejects(deliver({}, 'bad'), /signature/);
  await assert.rejects(deliver({ amount: 18 }), /amount mismatch/);
  await assert.rejects(deliver({ currency: 'EUR' }), /amount mismatch/);
  await assert.rejects(deliver({ id: 'wrong-provider-id' }), /ID mismatch/);
  await deliver({ state: 'AUTHORIZED' });
  assert.deepEqual(await balance(), { credits: 0, value: 0 });
  // Plans changing after checkout must never change the purchase already created.
  await db.query("UPDATE plans SET credits=5000,monthly_cents=5000 WHERE id='creator'");
  await Promise.all([deliver(), deliver(), deliver()]);
  assert.deepEqual(await balance(), { credits: 1000, value: 19 });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM top_ups'))[0].n, 1);
  await deliver({ state: 'CANCELLED' });
  assert.equal((await service.list(user.id))[0].status, 'completed');
  const body = Buffer.from('{"test": true}');
  assert(validSignature(body, createHmac('sha256','k').update(body).digest('base64'), 'k'));
  assert(!validSignature(Buffer.from('modified'), createHmac('sha256','k').update(body).digest('hex'), 'k'));
  const edited = { ...details, firstName: ' Updated ', city: 'Oxford' };
  globalThis.fetch = async () => { throw new Error('Provider timeout'); };
  await assert.rejects(service.checkout(user.id, 'studio', edited), /Could not open/);
  assert.deepEqual(await service.profile(user.id), { ...edited, firstName: 'Updated' }, 'Keep edited details even if provider is temporarily unavailable');
  await assert.rejects(service.checkout(user.id, 'studio', { ...edited, firstName: '   ' }), /Complete your billing/);
  assert.equal((await service.profile(user.id)).firstName, 'Updated');
  globalThis.fetch = async () => Response.json({errors:[{field:'customer.email',defaultMessage:'Invalid email address'}]}, {status:400});
  await assert.rejects(service.checkout(user.id,'studio',details), /Wemopay could not accept this payment email/);
  assert.equal((await service.list(user.id))[0].status,'failed','Provider validation failure must not stay pending');
  assert.deepEqual(await balance(), {credits:1000,value:19});
  // Custom purchases use an authoritative server quote and the same settlement ledger.
  assert.deepEqual(await (await originalFetch((await app.getUrl())+'/payments/custom-package')).json(), CUSTOM_PACKAGE);
  assert.equal(quoteCustomPackage(500).credits,250);
  assert.equal(quoteCustomPackage(50000).credits,25000);
  for (const amount of [undefined,null,'500',0,499,501,750,500.5,50500,NaN,Infinity]) {
    assert.throws(()=>quoteCustomPackage(amount), /\$5 to \$500/);
    await assert.rejects(service.checkout(user.id,'custom',{...details,customAmountCents:amount}), /\$5 to \$500/);
  }
  const checkoutUrl = (await app.getUrl())+'/payments/checkout';
  for (const body of [{...details,planId:'custom'}, {...details,planId:'custom',customAmountCents:750}, {...details,planId:'custom',customAmountCents:500,credits:999999}]) {
    const response=await originalFetch(checkoutUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,400,'Reject missing amounts, invalid steps and injected credits over HTTP');
  }
  const customProviderId=randomUUID();
  globalThis.fetch=async(_url,init)=>{outgoing=JSON.parse(init.body);return Response.json({result:{id:customProviderId,redirectUrl:'https://provider.invalid/custom'}});};
  const response=await originalFetch(checkoutUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...details,planId:'custom',customAmountCents:2500})});
  assert.equal(response.status,201);
  const customOrder=await response.json();
  assert.equal(outgoing.amount,25);
  const [snapshot]=await db.query('SELECT amount_cents,credits,plan_id FROM payments WHERE id=$1',[customOrder.id]);
  assert.deepEqual(snapshot,{amount_cents:2500,credits:1250,plan_id:'custom'});
  const customPayload=Buffer.from(JSON.stringify({id:customProviderId,referenceId:customOrder.id,paymentType:'DEPOSIT',state:'COMPLETED',amount:25,currency:'USD'}));
  const customSignature=createHmac('sha256','test-signing-key').update(customPayload).digest('hex');
  await Promise.all([service.webhook(customPayload,customSignature),service.webhook(customPayload,customSignature)]);
  assert.deepEqual(await balance(),{credits:2250,value:44});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM top_ups WHERE request_id=$1',[customOrder.id]))[0].n,1);
  console.log('PASS: custom $5 steps, bounds, HTTP validation, tampered credits, exact provider amount and once-only custom settlement');
  console.log('PASS: saved profiles, account isolation, edits, retry persistence, signature, amount, currency, provider ID, authorization, frozen package, concurrent retries and terminal status');
} finally {
  globalThis.fetch = originalFetch;
  if (app) await app.close();
  if (db.isInitialized) await db.destroy();
  await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control.end();
}
