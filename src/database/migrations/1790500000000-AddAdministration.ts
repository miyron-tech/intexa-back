import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddAdministration1790500000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE users ADD COLUMN role varchar(10) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')), ADD COLUMN credit_balance integer NOT NULL DEFAULT 0 CHECK (credit_balance >= 0)`,
    );
    await q.query(
      `CREATE TABLE plans (id varchar(30) PRIMARY KEY, name varchar(60) NOT NULL, monthly_cents integer NOT NULL CHECK (monthly_cents >= 0), annual_monthly_cents integer NOT NULL CHECK (annual_monthly_cents >= 0), credits integer NOT NULL CHECK (credits >= 0), version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `INSERT INTO plans (id,name,monthly_cents,annual_monthly_cents,credits) VALUES ('explorer','Explorer',0,0,30),('creator','Creator',1900,1520,1000),('studio','Studio',4900,3920,3000)`,
    );
    await q.query(
      `CREATE TABLE top_ups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid UNIQUE NOT NULL, user_id uuid NOT NULL REFERENCES users(id), actor_id uuid NOT NULL REFERENCES users(id), amount_cents integer NOT NULL CHECK (amount_cents > 0), credits integer NOT NULL CHECK (credits > 0), note varchar(500) NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE INDEX top_ups_user_date ON top_ups(user_id,created_at DESC)`,
    );
    await q.query(
      `CREATE TABLE admin_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users(id), action varchar(40) NOT NULL, target_id varchar(80) NOT NULL, before_data jsonb, after_data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE admin_audit, top_ups, plans');
    await q.query(
      'ALTER TABLE users DROP COLUMN role, DROP COLUMN credit_balance',
    );
  }
}
