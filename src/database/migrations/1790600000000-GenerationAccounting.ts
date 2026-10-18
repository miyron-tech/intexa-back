import type { MigrationInterface, QueryRunner } from 'typeorm';
export class GenerationAccounting1790600000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE users ADD COLUMN credit_value_usd numeric(18,8) NOT NULL DEFAULT 0 CHECK (credit_value_usd >= 0)`,
    );
    // Before billing was connected, top-ups were the only paid credit source.
    // Unfunded opening credits have zero value; never invent revenue for them.
    await q.query(
      `UPDATE users u SET credit_value_usd = coalesce((SELECT round(sum(t.amount_cents)::numeric/100 * least(u.credit_balance::numeric/sum(t.credits),1),8) FROM top_ups t WHERE t.user_id=u.id),0)`,
    );
    await q.query(`ALTER TABLE generation_jobs
      ADD COLUMN credits_reserved integer NOT NULL DEFAULT 0 CHECK (credits_reserved >= 0),
      ADD COLUMN credits_charged integer NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
      ADD COLUMN reserved_value_usd numeric(18,8) NOT NULL DEFAULT 0,
      ADD COLUMN revenue_usd numeric(18,8) NOT NULL DEFAULT 0,
      ADD COLUMN billing_status varchar(20) NOT NULL DEFAULT 'legacy' CHECK (billing_status IN ('legacy','reserved','charged','refunded')),
      ADD COLUMN request_id uuid,
      ADD COLUMN request_hash varchar(64),
      ADD COLUMN pricing_version varchar(30),
      ADD COLUMN remote_id varchar(200),
      ALTER COLUMN cost_usd TYPE numeric(18,8)`);
    await q.query(
      `CREATE UNIQUE INDEX generation_request_key ON generation_jobs(user_id,request_id) WHERE request_id IS NOT NULL`,
    );
    await q.query(`CREATE TABLE generation_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
      kind varchar(20) NOT NULL, model varchar(120) NOT NULL, prompt text NOT NULL,
      cost_usd numeric(18,8), input_tokens bigint, output_tokens bigint,
      provider_id varchar(200), state varchar(20) NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`);
    await q.query(
      `CREATE INDEX generation_usage_job ON generation_usage(job_id)`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE generation_usage');
    await q.query('DROP INDEX generation_request_key');
    await q.query(
      `ALTER TABLE generation_jobs DROP COLUMN credits_reserved, DROP COLUMN credits_charged, DROP COLUMN reserved_value_usd, DROP COLUMN revenue_usd, DROP COLUMN billing_status, DROP COLUMN request_id, DROP COLUMN request_hash, DROP COLUMN pricing_version, DROP COLUMN remote_id`,
    );
    await q.query('ALTER TABLE users DROP COLUMN credit_value_usd');
  }
}
