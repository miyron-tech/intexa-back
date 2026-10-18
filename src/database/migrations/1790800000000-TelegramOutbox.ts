import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Team notifications in the Telegram topic. Same outbox approach as email_outbox:
 * registration / payment rows are written by triggers inside the originating transaction,
 * the payload is a snapshot of the facts at that moment.
 */
export class TelegramOutbox1790800000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE telegram_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event varchar(30) NOT NULL CHECK (event IN ('registration','payment','order_email_failed')),
      payload jsonb NOT NULL,
      status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE INDEX telegram_outbox_due ON telegram_outbox(next_attempt_at) WHERE status='pending'`,
    );
    await q.query(`CREATE FUNCTION enqueue_registration_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO telegram_outbox(event,payload)
        VALUES('registration',jsonb_build_object('email',NEW.email,'at',NEW.created_at));
        RETURN NEW;
      END $$`);
    await q.query(`CREATE FUNCTION enqueue_payment_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- Admin inserts the top-up before crediting the user in the same transaction
        INSERT INTO telegram_outbox(event,payload)
        SELECT 'payment', jsonb_build_object(
          'topUpId',NEW.id,'at',NEW.created_at,'email',u.email,'actorEmail',a.email,
          'amountCents',NEW.amount_cents,'credits',NEW.credits,'balanceAfter',u.credit_balance+NEW.credits,
          'plan',(SELECT p.name FROM plans p WHERE p.credits=NEW.credits AND p.monthly_cents=NEW.amount_cents LIMIT 1))
        FROM users u, users a WHERE u.id=NEW.user_id AND a.id=NEW.actor_id;
        RETURN NEW;
      END $$`);
    await q.query(
      `CREATE TRIGGER users_registration_notice AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION enqueue_registration_notice()`,
    );
    await q.query(
      `CREATE TRIGGER top_ups_payment_notice AFTER INSERT ON top_ups FOR EACH ROW EXECUTE FUNCTION enqueue_payment_notice()`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER top_ups_payment_notice ON top_ups');
    await q.query('DROP TRIGGER users_registration_notice ON users');
    await q.query('DROP FUNCTION enqueue_payment_notice, enqueue_registration_notice');
    await q.query('DROP TABLE telegram_outbox');
  }
}
