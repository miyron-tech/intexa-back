import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import { DataSource } from 'typeorm';
import { orderNumber } from '../common/order-number.js';
import type { Env } from '../config/env.js';
import { enqueueTelegram } from '../notifications/telegram-outbox.service.js';
import {
  company,
  LEGAL_VERSION,
  orderEmail,
  type RenderedEmail,
  welcomeEmail,
} from './templates.js';

const POLL_MS = 10_000;
const BATCH = 10;
const MAX_ATTEMPTS = 8;
/** A claimed row is not picked up again for this long, so a crash mid-send cannot double-send within minutes. */
const LEASE = '10 minutes';
const TIME_ZONE = 'Europe/Vilnius';

interface OutboxRow {
  id: string;
  kind: 'welcome' | 'order_confirmation';
  user_id: string;
  top_up_id: string | null;
  attempts: number;
  payload: { creditBalance?: number; balanceAfter?: number };
}

const legalPdf = (name: string) =>
  fileURLToPath(new URL(`./legal/${name}-${LEGAL_VERSION}.pdf`, import.meta.url));

/**
 * Sends rows from email_outbox (filled by DB triggers on users / top_ups).
 * Without SMTP_HOST: development saves .eml files to STORAGE_DIR/mail-outbox,
 * production leaves rows pending until SMTP is configured.
 */
@Injectable()
export class MailOutboxService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MailOutboxService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private transport?: Transporter;
  private fileDir?: string;

  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    const host = this.config.get('SMTP_HOST', { infer: true });
    if (host) {
      const user = this.config.get('SMTP_USER', { infer: true });
      this.transport = nodemailer.createTransport({
        host,
        port: this.config.get('SMTP_PORT', { infer: true }),
        secure: this.config.get('SMTP_SECURE', { infer: true }),
        auth: user
          ? { user, pass: this.config.get('SMTP_PASS', { infer: true }) }
          : undefined,
      });
    } else if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
      this.transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
      this.fileDir = join(this.config.get('STORAGE_DIR', { infer: true }), 'mail-outbox');
      this.logger.warn(`SMTP_HOST is not set: emails are saved to ${this.fileDir}`);
    } else {
      this.logger.error('SMTP_HOST is not set: transactional emails stay queued in email_outbox');
      return;
    }
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.tick();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // For UPDATE … RETURNING the postgres driver resolves to [rows, affectedCount]
      const [rows]: [OutboxRow[], number] = await this.db.query(
        `UPDATE email_outbox SET attempts=attempts+1, next_attempt_at=now()+interval '${LEASE}'
         WHERE id IN (SELECT id FROM email_outbox WHERE status='pending' AND next_attempt_at<=now()
                      ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
         RETURNING id, kind, user_id, top_up_id, attempts, payload`,
      );
      for (const row of rows) await this.deliver(row);
    } catch (error) {
      this.logger.error(`Outbox poll failed: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    try {
      const { to, email, attachments } = await this.compose(row);
      const info = await this.transport!.sendMail({
        from: this.config.get('MAIL_FROM', { infer: true }),
        replyTo: company.email,
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments,
      });
      if (this.fileDir) {
        await mkdir(this.fileDir, { recursive: true });
        await writeFile(join(this.fileDir, `${row.kind}-${row.id}.eml`), info.message as Buffer);
      }
      await this.db.query(
        `UPDATE email_outbox SET status='sent', sent_at=now(), message_id=$2, last_error=NULL WHERE id=$1`,
        [row.id, String(info.messageId ?? '').slice(0, 300)],
      );
    } catch (error) {
      const failed = row.attempts >= MAX_ATTEMPTS;
      // Backoff: 1, 2, 4 … 64 minutes between attempts
      const delayMinutes = 2 ** (row.attempts - 1);
      await this.db.query(
        `UPDATE email_outbox SET status=$2, last_error=$3, next_attempt_at=now()+make_interval(mins => $4) WHERE id=$1`,
        [row.id, failed ? 'failed' : 'pending', String(error).slice(0, 2000), delayMinutes],
      );
      this.logger.error(
        `Email ${row.kind} ${row.id} attempt ${row.attempts} failed${failed ? ', giving up' : ''}: ${String(error)}`,
      );
      // The order confirmation is legally required: tell the team on the first failure and when we give up
      if (row.kind === 'order_confirmation' && (row.attempts === 1 || failed))
        await this.alertTeam(row, error, failed).catch((alertError: unknown) =>
          this.logger.error(`Telegram alert for ${row.id} failed: ${String(alertError)}`),
        );
    }
  }

  private async alertTeam(row: OutboxRow, error: unknown, final: boolean): Promise<void> {
    const [order] = await this.db.query(
      'SELECT t.id, t.created_at, u.email FROM top_ups t JOIN users u ON u.id=t.user_id WHERE t.id=$1',
      [row.top_up_id],
    );
    await enqueueTelegram(this.db, 'order_email_failed', {
      orderId: orderNumber(order.id, new Date(order.created_at)),
      email: order.email,
      error: String(error),
      attempts: row.attempts,
      final,
    });
  }

  private async compose(row: OutboxRow) {
    const site = this.config.get('FRONTEND_URL', { infer: true }).replace(/\/+$/, '');
    if (row.kind === 'welcome') {
      const [user] = await this.db.query('SELECT email FROM users WHERE id=$1', [row.user_id]);
      return {
        to: user.email as string,
        email: welcomeEmail({ site, email: user.email, creditBalance: row.payload.creditBalance ?? 0 }),
        attachments: [],
      };
    }

    const [order] = await this.db.query(
      `SELECT t.id, t.amount_cents, t.credits, t.created_at, u.email,
              (SELECT p.name FROM plans p WHERE p.credits=t.credits AND p.monthly_cents=t.amount_cents LIMIT 1) AS plan
       FROM top_ups t JOIN users u ON u.id=t.user_id WHERE t.id=$1`,
      [row.top_up_id],
    );
    const createdAt = new Date(order.created_at);
    const email: RenderedEmail = orderEmail({
      site,
      email: order.email,
      orderId: orderNumber(order.id, createdAt),
      date: formatDateTime(createdAt),
      withdrawUntil: formatDate(new Date(createdAt.getTime() + 14 * 86_400_000)),
      plan: order.plan ?? 'Credit top-up',
      credits: order.credits,
      price: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
        order.amount_cents / 100,
      ),
      balance: row.payload.balanceAfter ?? order.credits,
      // Top-ups are recorded by an administrator after payment is agreed with support
      method: 'Arranged with support',
    });
    return {
      to: order.email as string,
      email,
      attachments: [
        { filename: `Terms-of-Service-${LEGAL_VERSION}.pdf`, path: legalPdf('terms-of-service') },
        {
          filename: `Refund-and-Withdrawal-Policy-${LEGAL_VERSION}.pdf`,
          path: legalPdf('refund-and-withdrawal-policy'),
        },
      ],
    };
  }
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: TIME_ZONE }).format(date);
}

function formatDateTime(date: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIME_ZONE,
    timeZoneName: 'short',
  }).format(date);
  return `${formatDate(date)}, ${time}`;
}
