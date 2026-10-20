import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { buildDataSourceOptions } from '../dist/database/data-source.js';
import { GenerationJob } from '../dist/generation/entities/generation-job.entity.js';
import {
  GenerationController,
  toJobResponse,
} from '../dist/generation/generation.controller.js';
import { BillingService } from '../dist/generation/billing.service.js';
import { JobRunnerService } from '../dist/generation/job-runner.service.js';
import { getService } from '../dist/generation/services.catalog.js';
import {
  quoteCredits,
  publicService,
} from '../dist/generation/credit-pricing.js';
const schema = 'content_test_' + randomUUID().replaceAll('-', '');
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
await control.connect();
await control.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new DataSource({
  ...buildDataSourceOptions(url.toString()),
  schema,
});
try {
  await db.initialize();
  await db.runMigrations();
  const repo = db.getRepository(GenerationJob),
    billing = new BillingService(db);
  const [user] = await db.query(
    "INSERT INTO users(email,password_hash,credit_balance,credit_value_usd) VALUES('content@example.invalid','not-a-login',20,0.4) RETURNING id",
  );
  const controller = new GenerationController(
    repo,
    { enqueue() {} },
    {},
    {},
    billing,
  );
  const service = getService('content_optimization');
  assert.equal(publicService(service).creditsPerImage, 5);
  assert.equal(quoteCredits(service, {}), 5);
  assert.throws(() => quoteCredits(service, { count: 2 }), /Unsupported/);
  const dto = {
    service: 'content_optimization',
    preset: 'tiktok',
    requestId: randomUUID(),
    expectedCredits: 5,
    description: 'Придумай описание для видео о керамической кружке',
  };
  await assert.rejects(
    controller.create({ sub: user.id }, { ...dto, description: '' }),
    /Describe/,
  );
  await assert.rejects(
    controller.create({ sub: user.id }, { ...dto, expectedCredits: 1 }),
    /price/,
  );
  let calls = 0,
    fail = false;
  const client = {
    complete: async (model, system, prompt, report) => {
      calls++;
      assert.equal(model, 'test-content-model');
      assert(system.includes('same language'));
      assert.equal(prompt, dto.description);
      await report(
        { cost: 0.001, prompt_tokens: 100, completion_tokens: 200 },
        'mock-text',
      );
      if (fail) throw Error('Provider unavailable');
      return 'Вариант 1\nУют начинается с любимой кружки. #керамика\n\nВариант 2\nТвоё утро заслуживает красивых деталей.\n\nВариант 3\nМаленький ритуал на каждый день.';
    },
  };
  const runner = new JobRunnerService(
    repo,
    client,
    {},
    {},
    new ConfigService({ OPENROUTER_TEXT_MODEL: 'test-content-model' }),
    billing,
  );
  const job = await controller.create({ sub: user.id }, dto);
  assert.equal((await controller.create({ sub: user.id }, dto)).id, job.id);
  await runner.run(job.id);
  const result = await repo.findOneByOrFail({ id: job.id });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.creditsCharged, 5);
  assert.equal(calls, 1);
  assert(toJobResponse(result).params.contentResult.includes('Вариант 1'));
  await assert.rejects(
    controller.get({ sub: randomUUID() }, job.id),
    /not found/,
  );
  assert.equal(
    Number(
      (
        await db.query('SELECT cost_usd FROM generation_jobs WHERE id=$1', [
          job.id,
        ])
      )[0].cost_usd,
    ),
    0.001,
  );
  fail = true;
  const failed = await controller.create(
    { sub: user.id },
    { ...dto, requestId: randomUUID() },
  );
  await runner.run(failed.id);
  assert.equal(
    (await repo.findOneByOrFail({ id: failed.id })).billingStatus,
    'refunded',
  );
  assert.equal(
    (
      await db.query('SELECT credit_balance FROM users WHERE id=$1', [user.id])
    )[0].credit_balance,
    15,
  );
  console.log(
    'PASS: text generation, 5-credit quote, validation, idempotency, private results, real usage accounting and failure refund. No paid calls.',
  );
} finally {
  if (db.isInitialized) await db.destroy();
  await control.query(`DROP SCHEMA "${schema}" CASCADE`);
  await control.end();
}
