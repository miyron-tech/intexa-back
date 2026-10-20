import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { buildDataSourceOptions } from '../dist/database/data-source.js';
import { GenerationJob } from '../dist/generation/entities/generation-job.entity.js';
import { GenerationController } from '../dist/generation/generation.controller.js';
import { BillingService } from '../dist/generation/billing.service.js';
import { JobRunnerService } from '../dist/generation/job-runner.service.js';
import { StorageService } from '../dist/generation/storage.service.js';
import { ImageService } from '../dist/generation/image.service.js';
import { quoteCredits } from '../dist/generation/credit-pricing.js';
import { getService } from '../dist/generation/services.catalog.js';
const schema = 'size_test_' + randomUUID().replaceAll('-', ''),
  folder = await mkdtemp(join(tmpdir(), 'image-size-'));
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
  const config = new ConfigService({
      STORAGE_DIR: folder,
      OPENROUTER_TEXT_MODEL: 'test-model',
    }),
    storage = new StorageService(config),
    images = new ImageService();
  const [user] = await db.query(
    "INSERT INTO users(email,password_hash,credit_balance) VALUES('size@example.invalid','not-a-login',100) RETURNING id",
  );
  const buffer = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: '#aaccee' },
  })
    .png()
    .toBuffer();
  const client = {
    complete: async () => 'A product photograph',
    generateImage: async (_model, _prompt, _inputs, report) => {
      await report({ cost: 0.01 }, 'test-image');
      return { images: [{ buffer, mimeType: 'image/png' }], costUsd: 0.01 };
    },
  };
  const controller = new GenerationController(
      repo,
      { enqueue() {} },
      storage,
      images,
      billing,
    ),
    runner = new JobRunnerService(
      repo,
      client,
      storage,
      images,
      config,
      billing,
    );
  const dto = {
    service: 'product_shot',
    preset: 'studio',
    description: 'A mug',
    requestId: randomUUID(),
    expectedCredits: 10,
    inputs: ['data:image/png;base64,' + buffer.toString('base64')],
    outputWidth: 800,
    outputHeight: 600,
  };
  const job = await controller.create({ sub: user.id }, dto);
  await runner.run(job.id);
  const result = await repo.findOneByOrFail({ id: job.id });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs[0].width, 800);
  assert.equal(result.outputs[0].height, 600);
  assert.equal(result.creditsCharged, 10);
  const square = await controller.create(
    { sub: user.id },
    {
      ...dto,
      requestId: randomUUID(),
      outputWidth: undefined,
      outputHeight: undefined,
      aspectRatio: '1:1',
    },
  );
  await runner.run(square.id);
  const output = (await repo.findOneByOrFail({ id: square.id })).outputs[0];
  assert.equal(output.width, 1024);
  assert.equal(output.height, 1024);
  assert.throws(
    () =>
      quoteCredits(getService('product_shot'), {
        ...dto,
        outputHeight: undefined,
      }),
    /both image dimensions/,
  );
  assert.throws(
    () =>
      quoteCredits(getService('product_shot'), { ...dto, outputWidth: 100000 }),
    /both image dimensions/,
  );
  assert.throws(
    () => quoteCredits(getService('video_ad'), dto),
    /both image dimensions/,
  );
  console.log(
    'PASS: real output resize, aspect ratio crop, paired bounds validation and unchanged image credit price. No paid calls.',
  );
} finally {
  if (db.isInitialized) await db.destroy();
  await control.query(`DROP SCHEMA "${schema}" CASCADE`);
  await control.end();
  await rm(folder, { recursive: true, force: true });
}
