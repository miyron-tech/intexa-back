import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  GenerationJob,
  type JobOutput,
} from './entities/generation-job.entity.js';
import { PRICING_VERSION } from './credit-pricing.js';

export interface ProviderUsage {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}
export type UsageReporter = (
  usage: ProviderUsage | undefined,
  providerId?: string,
) => Promise<void>;

@Injectable()
export class BillingService {
  constructor(private readonly db: DataSource) {}

  async reserve(
    userId: string,
    requestId: string,
    hash: string,
    credits: number,
    fields: Partial<GenerationJob>,
  ) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.query(
        'SELECT id,credit_balance FROM users WHERE id=$1 FOR UPDATE',
        [userId],
      );
      if (!user) throw new BadRequestException('Account not found');
      const repo = tx.getRepository(GenerationJob);
      const existing = await repo.findOneBy({ userId, requestId });
      if (existing) {
        if (existing.requestHash !== hash)
          throw new ConflictException(
            'This request has already been used. Reload to start a new generation.',
          );
        return { job: existing, created: false };
      }
      if (user.credit_balance < credits)
        throw new BadRequestException(
          `Not enough credits. This generation needs ${credits} credits; your balance is ${user.credit_balance}.`,
        );
      const [allocation] = await tx.query(
        `SELECT round(credit_value_usd*$2/credit_balance,8)::text AS value FROM users WHERE id=$1`,
        [userId, credits],
      );
      await tx.query(
        'UPDATE users SET credit_balance=credit_balance-$2, credit_value_usd=credit_value_usd-$3 WHERE id=$1',
        [userId, credits, allocation.value],
      );
      const job = await repo.save(
        repo.create({
          ...fields,
          userId,
          requestId,
          requestHash: hash,
          creditsReserved: credits,
          creditsCharged: 0,
          reservedValueUsd: allocation.value,
          revenueUsd: '0',
          billingStatus: 'reserved',
          pricingVersion: PRICING_VERSION,
        }),
      );
      return { job, created: true };
    });
  }

  async finish(
    jobId: string,
    succeeded: boolean,
    outputs: JobOutput[] = [],
    error?: string,
  ) {
    await this.db.transaction(async (tx) => {
      const repo = tx.getRepository(GenerationJob);
      const job = await repo.findOne({
        where: { id: jobId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job || job.status === 'succeeded' || job.status === 'failed') return;
      const reserved = job.billingStatus === 'reserved';
      if (reserved && !succeeded) {
        await tx.query(
          'UPDATE users SET credit_balance=credit_balance+$2, credit_value_usd=credit_value_usd+$3 WHERE id=$1',
          [job.userId, job.creditsReserved, job.reservedValueUsd],
        );
      }
      await repo.update(jobId, {
        status: succeeded ? 'succeeded' : 'failed',
        outputs,
        error: succeeded ? null : (error ?? 'Generation failed').slice(0, 2000),
        finishedAt: new Date(),
        ...(reserved
          ? {
              billingStatus: succeeded ? 'charged' : 'refunded',
              creditsCharged: succeeded ? job.creditsReserved : 0,
              revenueUsd: succeeded ? job.reservedValueUsd : '0',
            }
          : {}),
      });
    });
  }

  async startUsage(
    jobId: string,
    kind: string,
    model: string,
    prompt: string,
  ): Promise<UsageReporter> {
    const [call] = await this.db.query(
      `INSERT INTO generation_usage(job_id,kind,model,prompt) VALUES($1,$2,$3,$4) RETURNING id`,
      [jobId, kind, model, prompt],
    );
    return async (usage, providerId) => {
      const cost =
        typeof usage?.cost === 'number' &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : null;
      const tokens = (n?: number) =>
        typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
      await this.db.transaction(async (tx) => {
        await tx.query(
          'SELECT id FROM generation_jobs WHERE id=$1 FOR UPDATE',
          [jobId],
        );
        await tx.query(
          `UPDATE generation_usage SET cost_usd=$2,input_tokens=$3,output_tokens=$4,provider_id=$5,state='reported',finished_at=now() WHERE id=$1`,
          [
            call.id,
            cost,
            tokens(usage?.prompt_tokens),
            tokens(usage?.completion_tokens),
            providerId ?? null,
          ],
        );
        await tx.query(
          `UPDATE generation_jobs SET cost_usd=(SELECT coalesce(sum(cost_usd),0) FROM generation_usage WHERE job_id=$1) WHERE id=$1`,
          [jobId],
        );
      });
    };
  }
}
