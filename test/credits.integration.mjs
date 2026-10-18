import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../dist/database/data-source.js';
import { BillingService } from '../dist/generation/billing.service.js';
import { AdminService } from '../dist/admin/admin.service.js';
import { EconomicsService } from '../dist/admin/economics.service.js';
import { GenerationController } from '../dist/generation/generation.controller.js';
import { GenerationJob } from '../dist/generation/entities/generation-job.entity.js';
import { JobRunnerService } from '../dist/generation/job-runner.service.js';
import { OpenRouterClient } from '../dist/generation/openrouter.client.js';
import {
  publicService,
  quoteCredits,
} from '../dist/generation/credit-pricing.js';
import { SERVICES, getService } from '../dist/generation/services.catalog.js';

// Every table, migration and transaction lives in a disposable isolated schema.
// No real provider requests, payments or production users are used.
const schema = `credit_test_${randomUUID().replaceAll('-', '')}`;
const baseUrl = process.env.DATABASE_URL;
assert(baseUrl, 'Set DATABASE_URL');
const control = new pg.Client({ connectionString: baseUrl });
await control.connect();
await control.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(baseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new DataSource({
  ...buildDataSourceOptions(url.toString()),
  schema,
});
const initialFetch = globalThis.fetch;
try {
  await db.initialize();
  await db.runMigrations();
  const billing = new BillingService(db);
  const admin = new AdminService(db);
  const economics = new EconomicsService(db);
  const repo = db.getRepository(GenerationJob);
  const [user] = await db.query(
    "INSERT INTO users(email,password_hash) VALUES('credit-test@example.invalid','not-a-login-hash') RETURNING id",
  );
  const [actor] = await db.query(
    "INSERT INTO users(email,password_hash,role) VALUES('credit-admin@example.invalid','not-a-login-hash','admin') RETURNING id",
  );
  const topup = {
    requestId: randomUUID(),
    email: 'credit-test@example.invalid',
    amountCents: 200,
    credits: 100,
    note: 'Isolated test payment',
  };
  const concurrentTopups = await Promise.all([
    admin.addTopUp(topup, actor.id),
    admin.addTopUp(topup, actor.id),
  ]);
  assert.equal(concurrentTopups[0].id, concurrentTopups[1].id);
  const balance = async () =>
    (
      await db.query(
        'SELECT credit_balance AS credits,credit_value_usd::float8 AS value FROM users WHERE id=$1',
        [user.id],
      )
    )[0];
  assert.deepEqual(await balance(), { credits: 100, value: 2 });
  const fields = {
    service: 'video_ad',
    preset: 'custom',
    status: 'queued',
    outputs: [],
    params: { description: 'My scene' },
  };
  const key = randomUUID();
  const duplicate = await Promise.all([
    billing.reserve(user.id, key, 'same', 50, fields),
    billing.reserve(user.id, key, 'same', 50, fields),
  ]);
  assert.equal(duplicate[0].job.id, duplicate[1].job.id);
  assert.equal(duplicate.filter((x) => x.created).length, 1);
  assert.deepEqual(await balance(), { credits: 50, value: 1 });
  await assert.rejects(
    billing.reserve(user.id, key, 'different', 50, fields),
    /already been used/,
  );
  await assert.rejects(
    billing.reserve(user.id, randomUUID(), 'too-expensive', 60, fields),
    /Not enough credits/,
  );
  const job = duplicate[0].job;
  const report = await billing.startUsage(
    job.id,
    'video',
    'test/video',
    'My exact prompt',
  );
  await report(
    { cost: 0.25, prompt_tokens: 3, completion_tokens: 4 },
    'provider-test',
  );
  await report(
    { cost: 0.25, prompt_tokens: 3, completion_tokens: 4 },
    'provider-test',
  );
  await Promise.all([
    billing.finish(job.id, true, [
      { path: 'test.mp4', mimeType: 'video/mp4', bytes: 10 },
    ]),
    billing.finish(job.id, true, [
      { path: 'test.mp4', mimeType: 'video/mp4', bytes: 10 },
    ]),
  ]);
  const charged = await repo.findOneByOrFail({ id: job.id });
  assert.equal(charged.creditsCharged, 50);
  assert.equal(Number(charged.revenueUsd), 1);
  assert.equal(Number(charged.costUsd), 0.25);
  assert.deepEqual(await balance(), { credits: 50, value: 1 });
  let detail = await economics.user(user.id, 1);
  assert.equal(detail.user.profitUsd, 0.75);
  assert.equal(detail.jobs.rows[0].usage[0].prompt, 'My exact prompt');
  assert(!JSON.stringify(detail.jobs.rows[0].outputs).includes('test.mp4'));
  // Refunds retain provider expense and remain idempotent under concurrent calls.
  const refund = await billing.reserve(
    user.id,
    randomUUID(),
    'refund',
    20,
    fields,
  );
  const refundReport = await billing.startUsage(
    refund.job.id,
    'video',
    'test/video',
    'Failed scene',
  );
  await refundReport({ cost: 0.1 });
  await Promise.all([
    billing.finish(refund.job.id, false, [], 'failed'),
    billing.finish(refund.job.id, false, [], 'failed'),
  ]);
  assert.deepEqual(await balance(), { credits: 50, value: 1 });
  detail = await economics.user(user.id, 1);
  assert.equal(detail.user.profitUsd, 0.65);
  assert.equal(detail.user.creditsRefunded, 20);
  // The remaining credit value changes only with real payment receipts.
  await admin.addTopUp(
    { ...topup, requestId: randomUUID(), amountCents: 100, credits: 100 },
    actor.id,
  );
  const weighted = await billing.reserve(
    user.id,
    randomUUID(),
    'weighted',
    75,
    fields,
  );
  assert.equal(Number(weighted.job.reservedValueUsd), 1);
  assert.deepEqual(await balance(), { credits: 75, value: 1 });
  await billing.finish(weighted.job.id, false);
  const race = await Promise.allSettled([
    billing.reserve(user.id, randomUUID(), 'race1', 100, fields),
    billing.reserve(user.id, randomUUID(), 'race2', 100, fields),
  ]);
  assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
  for (const result of race)
    if (result.status === 'fulfilled')
      await billing.finish(result.value.job.id, false);
  assert.deepEqual(await balance(), { credits: 150, value: 2 });
  // Missing cost is not fabricated as zero profit.
  const unknown = await billing.reserve(
    user.id,
    randomUUID(),
    'unknown',
    10,
    fields,
  );
  const missing = await billing.startUsage(
    unknown.job.id,
    'video',
    'test/video',
    'Unknown bill',
  );
  await missing(undefined);
  await billing.finish(unknown.job.id, false);
  assert.equal((await economics.user(user.id, 1)).user.profitUsd, null);
  assert.equal(
    (await economics.summary()).models.find((m) => m.model === 'test/video')
      .unknownCosts,
    1,
  );
  // Public API redaction and strict pricing validation.
  const controller = new GenerationController(
    repo,
    { enqueue() {} },
    {},
    { prepareInput: async (x) => x },
    billing,
  );
  const publicJob = await controller.get({ sub: user.id }, job.id);
  assert(!('model' in publicJob));
  assert(!('costUsd' in publicJob));
  const catalog = SERVICES.map(publicService);
  assert(
    !/openrouter|gemini|deepseek|wan-3|veo|usdPerSecond|imageModel/.test(
      JSON.stringify(catalog),
    ),
  );
  assert.equal(
    quoteCredits(getService('video_ad'), {
      videoModel: 'premium',
      duration: 4,
    }),
    100,
  );
  assert.throws(
    () =>
      quoteCredits(getService('video_ad'), {
        videoModel: 'premium',
        duration: 61,
      }),
    /between 2 and 60/,
  );
  assert.throws(
    () => quoteCredits(getService('video_ad'), { videoModel: 'invalid' }),
    /Unknown quality/,
  );
  await assert.rejects(
    controller.create(
      { sub: user.id },
      {
        ...fields,
        requestId: randomUUID(),
        description: 'Hello',
        videoModel: 'draft',
        duration: 5,
        expectedCredits: 1,
      },
    ),
    /price has changed/,
  );
  // Mock only the external HTTP boundary. Exercise actual image runner and accounting.
  const client = new OpenRouterClient({
    get: (key) =>
      key === 'OPENROUTER_API_KEY' ? 'test-key' : 'http://localhost',
  });
  const images = { describe: async () => ({ width: 1, height: 1 }) };
  const storage = { save: async () => 'saved-test.png' };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify(
        calls === 1
          ? {
              id: 'text',
              usage: { cost: 0.002, prompt_tokens: 20, completion_tokens: 10 },
              choices: [{ message: { content: 'Translated prompt' } }],
            }
          : {
              id: 'image',
              usage: { cost: 0.04, prompt_tokens: 30, completion_tokens: 2 },
              choices: [
                {
                  message: {
                    images: [
                      { image_url: { url: 'data:image/png;base64,YQ==' } },
                    ],
                  },
                },
              ],
            },
      ),
      { status: 200 },
    );
  };
  const imageJob = await billing.reserve(user.id, randomUUID(), 'image', 10, {
    ...fields,
    service: 'product_shot',
    preset: 'studio',
    params: {
      description: 'My product',
      inputs: ['data:image/png;base64,YQ=='],
      count: 1,
    },
  });
  const runner = new JobRunnerService(
    repo,
    client,
    storage,
    images,
    { get: () => 'test/text' },
    billing,
  );
  await runner.run(imageJob.job.id);
  const result = await repo.findOneByOrFail({ id: imageJob.job.id });
  assert.equal(result.status, 'succeeded');
  assert.equal(Number(result.costUsd), 0.042);
  assert.equal(result.prompt, 'Translated prompt');
  assert.equal(result.creditsCharged, 10);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM generation_usage WHERE job_id=$1',
        [result.id],
      )
    )[0].n,
    2,
  );
  // A malformed provider result still records its billed cost before decoding fails.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        usage: { cost: 0.03 },
        choices: [{ message: { images: [{ image_url: { url: 'invalid' } }] } }],
      }),
      { status: 200 },
    );
  const failedJob = await billing.reserve(
    user.id,
    randomUUID(),
    'bad-image',
    10,
    {
      ...fields,
      service: 'product_shot',
      preset: 'studio',
      params: { inputs: ['test'], count: 1 },
    },
  );
  const beforeFail = await balance();
  await runner.run(failedJob.job.id);
  const failure = await repo.findOneByOrFail({ id: failedJob.job.id });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.billingStatus, 'refunded');
  assert.equal(Number(failure.costUsd), 0.03);
  assert.equal((await balance()).credits, beforeFail.credits + 10);
  assert(
    !(await controller.get({ sub: user.id }, failure.id)).error.includes(
      'model',
    ),
  );
  // Process restart refunds an interrupted reservation once.
  const interrupted = await billing.reserve(
    user.id,
    randomUUID(),
    'interrupted',
    10,
    { ...fields, status: 'running' },
  );
  await runner.onApplicationBootstrap();
  assert.equal(
    (await repo.findOneByOrFail({ id: interrupted.job.id })).billingStatus,
    'refunded',
  );
  // Custom video prompts, first-frame schema and terminal cost tracking.
  let videoBody;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/videos')) {
      videoBody = JSON.parse(options.body);
      return Response.json({ id: 'remote-video' });
    }
    if (String(url).endsWith('/videos/remote-video'))
      return Response.json({
        id: 'remote-video',
        status: 'completed',
        unsigned_urls: ['https://provider.invalid/test.mp4'],
        usage: { cost: 0.25 },
      });
    return new Response(Buffer.from('video'), {
      headers: { 'content-type': 'video/mp4' },
    });
  };
  const videoJob = await billing.reserve(
    user.id,
    randomUUID(),
    'custom-video',
    50,
    {
      ...fields,
      params: {
        description: 'Exact custom scene',
        inputs: ['data:image/png;base64,YQ=='],
        videoModel: 'draft',
        duration: 5,
      },
    },
  );
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay, ...args) =>
    delay === 10000
      ? originalTimeout(fn, 0, ...args)
      : originalTimeout(fn, delay, ...args);
  try {
    await runner.run(videoJob.job.id);
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
  assert.equal(videoBody.prompt, 'Exact custom scene');
  assert.deepEqual(videoBody.frame_images, [
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,YQ==' },
      frame_type: 'first_frame',
    },
  ]);
  const videoResult = await repo.findOneByOrFail({ id: videoJob.job.id });
  assert.equal(videoResult.status, 'succeeded');
  assert.equal(videoResult.creditsCharged, 50);
  assert.equal(Number(videoResult.costUsd), 0.25);
  assert.equal(videoResult.remoteId, 'remote-video');
  globalThis.fetch = initialFetch;
  // Exercise live JWT authentication and admin authorization at the HTTP boundary.
  const { Test } = await import('@nestjs/testing');
  const { APP_GUARD } = await import('@nestjs/core');
  const { ValidationPipe } = await import('@nestjs/common');
  const { getRepositoryToken } = await import('@nestjs/typeorm');
  const { JwtService } = await import('@nestjs/jwt');
  const { default: request } = await import('supertest');
  const { Readable } = await import('node:stream');
  const { AdminController } = await import('../dist/admin/admin.controller.js');
  const { AdminGuard } = await import('../dist/admin/admin.guard.js');
  const { JwtAuthGuard } =
    await import('../dist/auth/guards/jwt-auth.guard.js');
  const { StorageService } =
    await import('../dist/generation/storage.service.js');
  const { ImageService } = await import('../dist/generation/image.service.js');
  const jwt = new JwtService({
    secret: 'isolated-test-secret-with-no-production-access',
  });
  const module = await Test.createTestingModule({
    controllers: [AdminController, GenerationController],
    providers: [
      AdminService,
      EconomicsService,
      BillingService,
      AdminGuard,
      { provide: DataSource, useValue: db },
      { provide: getRepositoryToken(GenerationJob), useValue: repo },
      {
        provide: StorageService,
        useValue: { stream: () => Readable.from(Buffer.from('test output')) },
      },
      { provide: ImageService, useValue: {} },
      { provide: JobRunnerService, useValue: { enqueue() {} } },
      { provide: JwtService, useValue: jwt },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  try {
    const http = app.getHttpServer();
    const auth = (id) =>
      `Bearer ${jwt.sign({ sub: id, sid: randomUUID() }, { expiresIn: 60 })}`;
    for (const path of [
      '/admin/economics',
      `/admin/users/${user.id}`,
      `/admin/generations/${job.id}/files/0`,
    ]) {
      await request(http).get(path).expect(401);
      await request(http)
        .get(path)
        .set('authorization', auth(user.id))
        .expect(403);
      await request(http)
        .get(path)
        .set('authorization', auth(actor.id))
        .expect((response) =>
          assert.equal(
            response.status,
            200,
            `${path}: ${JSON.stringify(response.body)}`,
          ),
        );
    }
    const catalogResponse = await request(http)
      .get('/generation/catalog')
      .set('authorization', auth(user.id))
      .expect(200);
    assert(!JSON.stringify(catalogResponse.body).includes('usdPerSecond'));
    const publicResponse = await request(http)
      .get(`/generation/jobs/${job.id}`)
      .set('authorization', auth(user.id))
      .expect(200);
    assert(!('model' in publicResponse.body));
    await request(http)
      .get(`/generation/jobs/${job.id}`)
      .set('authorization', auth(actor.id))
      .expect(404);
    await request(http)
      .post('/generation/jobs')
      .set('authorization', auth(user.id))
      .send({
        service: 'video_ad',
        preset: 'custom',
        description: 'test',
        requestId: randomUUID(),
        expectedCredits: 1,
        videoModel: 'draft',
        duration: 5,
      })
      .expect(400);
    // A stale admin token cannot retain privileges after role revocation.
    const oldAdmin = auth(actor.id);
    await db.query("UPDATE users SET role='user' WHERE id=$1", [actor.id]);
    await request(http)
      .get(`/admin/generations/${job.id}/files/0`)
      .set('authorization', oldAdmin)
      .expect(403);
  } finally {
    await app.close();
  }
  console.log(
    'PASS: migration, concurrent top-ups, idempotent reservations, insufficient balance, exact purchase value, success/refund settlement, known and unknown provider costs, public redaction, quote validation, real runner with mocked HTTP, restart recovery, HTTP authentication and file authorization.',
  );
} finally {
  globalThis.fetch = initialFetch;
  if (db.isInitialized) await db.destroy();
  await control.query(`DROP SCHEMA "${schema}" CASCADE`);
  await control.end();
}
