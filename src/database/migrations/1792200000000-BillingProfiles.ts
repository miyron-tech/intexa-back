import type { MigrationInterface, QueryRunner } from 'typeorm';
export class BillingProfiles1792200000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE billing_profiles (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, details jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  }
  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE billing_profiles'); }
}
