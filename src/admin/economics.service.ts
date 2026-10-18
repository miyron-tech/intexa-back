import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Unknown/legacy costs must never turn into a falsely precise profit figure.
const complete = `j.billing_status <> 'legacy' AND j.status IN ('succeeded','failed') AND NOT EXISTS (SELECT 1 FROM generation_usage x WHERE x.job_id=j.id AND (x.cost_usd IS NULL OR x.state='pending'))`;
const totals = `count(*)::int AS generations,
  coalesce(sum(j.credits_charged),0)::float8 AS "creditsUsed",
  coalesce(sum(j.credits_reserved) FILTER (WHERE j.billing_status='reserved'),0)::float8 AS "creditsReserved",
  coalesce(sum(j.credits_reserved) FILTER (WHERE j.billing_status='refunded'),0)::float8 AS "creditsRefunded",
  coalesce(sum(j.cost_usd),0)::float8 AS "costUsd",
  coalesce(sum(j.revenue_usd),0)::float8 AS "revenueUsd",
  coalesce(sum(j.revenue_usd-j.cost_usd) FILTER (WHERE ${complete}),0)::float8 AS "confirmedProfitUsd",
  count(*) FILTER (WHERE NOT (${complete}))::int AS "incompleteCosts",
  CASE WHEN count(*) FILTER (WHERE NOT (${complete}))=0 THEN coalesce(sum(j.revenue_usd-j.cost_usd),0)::float8 END AS "profitUsd",
  count(*) FILTER (WHERE j.status='succeeded')::int AS succeeded,
  count(*) FILTER (WHERE j.status='failed')::int AS failed`;

@Injectable()
export class EconomicsService {
  constructor(private readonly db: DataSource) {}

  async summary() {
    const [metrics] = await this.db.query(
      `SELECT ${totals} FROM generation_jobs j`,
    );
    const [funding] = await this.db.query(`SELECT
      (SELECT coalesce(sum(amount_cents),0)::float8/100 FROM top_ups) AS "paymentsUsd",
      (SELECT coalesce(sum(credit_value_usd),0)::float8 FROM users) +
      (SELECT coalesce(sum(reserved_value_usd),0)::float8 FROM generation_jobs WHERE billing_status='reserved') AS "unspentValueUsd"`);
    const models = await this.db
      .query(`SELECT model,kind,count(*)::int AS calls,
      coalesce(sum(cost_usd),0)::float8 AS "costUsd",
      sum(input_tokens)::float8 AS "inputTokens",sum(output_tokens)::float8 AS "outputTokens",
      count(*) FILTER (WHERE cost_usd IS NULL)::int AS "unknownCosts"
      FROM generation_usage GROUP BY model,kind ORDER BY sum(cost_usd) DESC NULLS LAST`);
    return { ...metrics, ...funding, models };
  }

  async user(id: string, page: number) {
    const [user] = await this.db.query(
      `SELECT id,email,role,credit_balance AS "creditBalance",credit_value_usd::float8 AS "unspentValueUsd",created_at AS "createdAt" FROM users WHERE id=$1`,
      [id],
    );
    if (!user) throw new NotFoundException('User not found');
    const [metrics] = await this.db.query(
      `SELECT ${totals} FROM generation_jobs j WHERE j.user_id=$1`,
      [id],
    );
    const [payments] = await this.db.query(
      `SELECT coalesce(sum(amount_cents),0)::float8/100 AS "paymentsUsd" FROM top_ups WHERE user_id=$1`,
      [id],
    );
    const rows = await this.db.query(
      `SELECT j.id,j.service,j.preset,j.status,j.params - 'inputs' AS params,j.prompt,j.model,j.error,
      j.outputs,j.remote_id AS "remoteId",j.created_at AS "createdAt",j.finished_at AS "finishedAt",
      j.credits_reserved AS "creditsReserved",j.credits_charged AS "creditsCharged",j.billing_status AS "billingStatus",
      j.cost_usd::float8 AS "costUsd",j.revenue_usd::float8 AS "revenueUsd",j.pricing_version AS "pricingVersion",
      (${complete}) AS "costComplete",
      CASE WHEN ${complete} THEN (j.revenue_usd-j.cost_usd)::float8 END AS "profitUsd",
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'model',x.model,'prompt',x.prompt,
        'costUsd',x.cost_usd::float8,'inputTokens',x.input_tokens,'outputTokens',x.output_tokens,'state',x.state,'providerId',x.provider_id) ORDER BY x.created_at)
        FROM generation_usage x WHERE x.job_id=j.id),'[]') AS usage
      FROM generation_jobs j WHERE j.user_id=$1 ORDER BY j.created_at DESC,j.id LIMIT 20 OFFSET $2`,
      [id, (page - 1) * 20],
    );
    for (const row of rows)
      row.outputs = row.outputs.map(
        (
          o: {
            mimeType: string;
            width?: number;
            height?: number;
            bytes: number;
          },
          index: number,
        ) => ({
          index,
          mimeType: o.mimeType,
          width: o.width,
          height: o.height,
          bytes: o.bytes,
        }),
      );
    return {
      user: { ...user, ...payments, ...metrics },
      jobs: { rows, total: metrics.generations, page },
    };
  }

  async output(id: string, index: number) {
    const [job] = await this.db.query(
      'SELECT outputs FROM generation_jobs WHERE id=$1',
      [id],
    );
    const output = job?.outputs[index];
    if (!output) throw new NotFoundException('File not found');
    return output as { path: string; mimeType: string };
  }
}
