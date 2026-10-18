import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Payments1792100000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE payments (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
      plan_id varchar(30) NOT NULL, plan_name varchar(60) NOT NULL,
      amount_cents integer NOT NULL CHECK(amount_cents > 0), credits integer NOT NULL CHECK(credits > 0),
      currency varchar(3) NOT NULL DEFAULT 'USD', provider_id text UNIQUE, redirect_url text,
      status varchar(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','cancelled')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await q.query('CREATE INDEX payments_user_date ON payments(user_id,created_at DESC)');
  }
  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE payments'); }
}
