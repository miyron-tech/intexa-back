import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PasswordReset1792800000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE users ADD COLUMN password_changed_at timestamptz`);
    await q.query(`CREATE TABLE password_resets (
      token_hash varchar(64) PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz
    )`);
    await q.query(`CREATE INDEX password_resets_user ON password_resets(user_id, created_at)`);
    await q.query(`ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check`);
    await q.query(`ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK(kind IN ('welcome','order_confirmation','password_reset','password_changed'))`);
  }
  async down(q: QueryRunner) {
    await q.query(`DELETE FROM email_outbox WHERE kind IN ('password_reset','password_changed')`);
    await q.query(`ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check`);
    await q.query(`ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK(kind IN ('welcome','order_confirmation'))`);
    await q.query('DROP TABLE password_resets');
    await q.query('ALTER TABLE users DROP COLUMN password_changed_at');
  }
}
