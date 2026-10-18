import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env.js';
import { orderNumber } from '../common/order-number.js';

const POLL_MS = 5_000;
const BATCH = 10;
const MAX_ATTEMPTS = 10;
const LEASE = '2 minutes';
const TIMEOUT_MS = 8_000;
const TIME_ZONE = 'Europe/Vilnius';

type Event = 'registration' | 'payment' | 'order_email_failed';

interface OutboxRow {
  id: string;
  event: Event;
  payload: Record<string, any>;
  attempts: number;
}

/** Queues an event outside a DB trigger (e.g. from the mail worker). */
export async function enqueueTelegram(
  db: DataSource,
  event: Event,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.query('INSERT INTO telegram_outbox(event,payload) VALUES($1,$2::jsonb)', [
    event,
    JSON.stringify(payload),
  ]);
}

const escapeHtml = (value: unknown) =>
  String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const when = (iso: string) =>
  `${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE }).format(new Date(iso))} (Вильнюс)`;
const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const num = (value: number) => Number(value).toLocaleString('ru-RU');

/** Message lines per event. Values are escaped; only the header uses markup. */
function lines(event: Event, p: Record<string, any>): string[] {
  switch (event) {
    case 'registration':
      return ['🆕 Новая регистрация', `Email: ${p.email}`, `Время: ${when(p.at)}`];
    case 'payment':
      return [
        '✅ Оплата получена, кредиты начислены',
        `Заказ: #${orderNumber(p.topUpId, new Date(p.at))}`,
        `Пакет: ${p.plan ?? 'Произвольное пополнение'} · ${num(p.credits)} кредитов`,
        `Сумма: ${usd(p.amountCents)}`,
        `Клиент: ${p.email}`,
        `Баланс после: ${num(p.balanceAfter)} кредитов`,
        `Провёл: ${p.actorEmail}`,
        `Время: ${when(p.at)}`,
      ];
    case 'order_email_failed':
      return [
        p.final
          ? '🚨 Подтверждение покупки НЕ доставлено клиенту'
          : '⚠️ Не удалось отправить подтверждение покупки',
        `Заказ: #${p.orderId}`,
        `Клиент: ${p.email}`,
        `Ошибка: ${String(p.error).slice(0, 300)}`,
        p.final
          ? `Попытки исчерпаны (${p.attempts}). Отправьте подтверждение вручную с support@intexa-ai.com — это обязательно по закону.`
          : `Попытка ${p.attempts}, повторим автоматически.`,
      ];
  }
}

/**
 * Sends telegram_outbox rows to the team topic. Disabled (rows stay pending) until
 * TG_BOT_TOKEN and TG_CHAT_ID are set, so nothing is lost while it is not configured.
 */
@Injectable()
export class TelegramOutboxService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramOutboxService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('TG_BOT_TOKEN', { infer: true }) || !this.config.get('TG_CHAT_ID', { infer: true })) {
      this.logger.warn('TG_BOT_TOKEN / TG_CHAT_ID are not set: Telegram notifications stay queued');
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
        `UPDATE telegram_outbox SET attempts=attempts+1, next_attempt_at=now()+interval '${LEASE}'
         WHERE id IN (SELECT id FROM telegram_outbox WHERE status='pending' AND next_attempt_at<=now()
                      ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
         RETURNING id, event, payload, attempts`,
      );
      for (const row of rows) await this.deliver(row);
    } catch (error) {
      this.logger.error(`Telegram outbox poll failed: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    try {
      const retryAfter = await this.send(lines(row.event, row.payload));
      if (retryAfter !== null) {
        // Rate limited: wait as told, without spending an attempt
        await this.db.query(
          `UPDATE telegram_outbox SET attempts=attempts-1, next_attempt_at=now()+make_interval(secs => $2) WHERE id=$1`,
          [row.id, retryAfter],
        );
        return;
      }
      await this.db.query(
        `UPDATE telegram_outbox SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1`,
        [row.id],
      );
    } catch (error) {
      const failed = row.attempts >= MAX_ATTEMPTS;
      await this.db.query(
        `UPDATE telegram_outbox SET status=$2, last_error=$3, next_attempt_at=now()+make_interval(mins => $4) WHERE id=$1`,
        [row.id, failed ? 'failed' : 'pending', String(error).slice(0, 2000), Math.min(2 ** (row.attempts - 1), 60)],
      );
      this.logger.error(`Telegram ${row.event} ${row.id} attempt ${row.attempts} failed: ${String(error)}`);
    }
  }

  /** Returns seconds to wait when Telegram rate-limits us, null on success; throws otherwise. */
  private async send(body: string[]): Promise<number | null> {
    const token = this.config.get('TG_BOT_TOKEN', { infer: true });
    const topic = this.config.get('TG_TOPIC_ID', { infer: true });
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.get('TG_CHAT_ID', { infer: true }),
        ...(topic ? { message_thread_id: topic } : {}),
        text: ['<b>intexa-ai.com</b>', ...body.map(escapeHtml)].join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (response.status === 429 && result.parameters?.retry_after) return result.parameters.retry_after;
    if (!response.ok || !result.ok) throw new Error(`Telegram ${response.status}: ${result.description ?? 'no description'}`);
    return null;
  }
}
