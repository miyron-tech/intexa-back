import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transactional email outbox. Rows are written by triggers in the same transaction
 * as the user / top-up, so an email is never lost when SMTP is down and admin code
 * (or a future checkout) does not need to know about mail at all.
 */
export class EmailOutbox1790700000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE email_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind varchar(30) NOT NULL CHECK (kind IN ('welcome','order_confirmation')),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      top_up_id uuid REFERENCES top_ups(id),
      -- Facts as of the triggering event, so a later change cannot alter what the email states
      payload jsonb NOT NULL DEFAULT '{}',
      status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      message_id varchar(300),
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind = 'order_confirmation') = (top_up_id IS NOT NULL))
    )`);
    await q.query(
      `CREATE UNIQUE INDEX email_outbox_welcome ON email_outbox(user_id) WHERE kind='welcome'`,
    );
    await q.query(
      `CREATE UNIQUE INDEX email_outbox_top_up ON email_outbox(top_up_id) WHERE top_up_id IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX email_outbox_due ON email_outbox(next_attempt_at) WHERE status='pending'`,
    );
    await q.query(`CREATE FUNCTION enqueue_welcome_email() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO email_outbox(kind,user_id,payload) VALUES('welcome',NEW.id,jsonb_build_object('creditBalance',NEW.credit_balance)); RETURN NEW; END $$`);
    await q.query(`CREATE FUNCTION enqueue_order_email() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- Admin inserts the top-up before crediting the user in the same transaction
        INSERT INTO email_outbox(kind,user_id,top_up_id,payload)
        SELECT 'order_confirmation',NEW.user_id,NEW.id,jsonb_build_object('balanceAfter',credit_balance+NEW.credits) FROM users WHERE id=NEW.user_id;
        RETURN NEW;
      END $$`);
    // Only rows inserted from now on: existing accounts and past top-ups get no retroactive mail.
    await q.query(
      `CREATE TRIGGER users_welcome_email AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION enqueue_welcome_email()`,
    );
    await q.query(
      `CREATE TRIGGER top_ups_order_email AFTER INSERT ON top_ups FOR EACH ROW EXECUTE FUNCTION enqueue_order_email()`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER top_ups_order_email ON top_ups');
    await q.query('DROP TRIGGER users_welcome_email ON users');
    await q.query('DROP FUNCTION enqueue_order_email, enqueue_welcome_email');
    await q.query('DROP TABLE email_outbox');
  }
}
