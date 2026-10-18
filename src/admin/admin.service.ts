import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TopUpDto, UpdatePlanDto } from './dto/admin.dto.js';
@Injectable()
export class AdminService {
  constructor(private readonly db: DataSource) {}
  plans() {
    return this.db.query(
      `SELECT id,name,monthly_cents AS "monthlyCents",annual_monthly_cents AS "annualMonthlyCents",credits,version,updated_at AS "updatedAt" FROM plans ORDER BY monthly_cents,id`,
    );
  }
  async summary() {
    const [row] = await this.db.query(
      `SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM top_ups) AS "topUps", (SELECT coalesce(sum(amount_cents),0)::float8 FROM top_ups) AS "amountCents", (SELECT coalesce(sum(credit_balance),0)::float8 FROM users) AS "creditBalance"`,
    );
    return row;
  }
  async users(search: string, page: number) {
    const pattern = '%' + search.trim().replace(/[\\%_]/g, '\\$&') + '%';
    const [count] = await this.db.query(
      `SELECT count(*)::int AS total FROM users WHERE email ILIKE $1`,
      [pattern],
    );
    const rows = await this.db.query(
      `SELECT u.id,u.email,u.role,u.credit_balance AS "creditBalance",u.created_at AS "createdAt",(SELECT count(*)::int FROM generation_jobs j WHERE j.user_id=u.id) AS generations,
      (SELECT coalesce(sum(j.credits_charged),0)::float8 FROM generation_jobs j WHERE j.user_id=u.id) AS "creditsUsed",
      (SELECT coalesce(sum(j.cost_usd),0)::float8 FROM generation_jobs j WHERE j.user_id=u.id) AS "costUsd",
      (SELECT coalesce(sum(j.revenue_usd),0)::float8 FROM generation_jobs j WHERE j.user_id=u.id) AS "revenueUsd",
      (SELECT count(*)::int FROM generation_jobs j WHERE j.user_id=u.id AND
        (j.billing_status='legacy' OR j.status IN ('queued','running') OR EXISTS (SELECT 1 FROM generation_usage x WHERE x.job_id=j.id AND x.cost_usd IS NULL))) AS "incompleteCosts"
      FROM users u WHERE u.email ILIKE $1 ORDER BY u.created_at DESC,u.id LIMIT 20 OFFSET $2`,
      [pattern, (page - 1) * 20],
    );
    return { rows, total: count.total, page };
  }
  async topUps(search: string, page: number) {
    const pattern = '%' + search.trim().replace(/[\\%_]/g, '\\$&') + '%';
    const [count] = await this.db.query(
      `SELECT count(*)::int AS total FROM top_ups t JOIN users u ON u.id=t.user_id WHERE u.email ILIKE $1`,
      [pattern],
    );
    const rows = await this.db.query(
      `SELECT t.id,u.email,a.email AS "actorEmail",t.amount_cents AS "amountCents",t.credits,t.note,t.created_at AS "createdAt" FROM top_ups t JOIN users u ON u.id=t.user_id JOIN users a ON a.id=t.actor_id WHERE u.email ILIKE $1 ORDER BY t.created_at DESC,t.id LIMIT 20 OFFSET $2`,
      [pattern, (page - 1) * 20],
    );
    return { rows, total: count.total, page };
  }
  async updatePlan(id: string, dto: UpdatePlanDto, actor: string) {
    if (dto.annualMonthlyCents > dto.monthlyCents)
      throw new BadRequestException(
        'Annual monthly price cannot exceed the monthly price',
      );
    return this.db.transaction(async (tx) => {
      const [before] = await tx.query(
        'SELECT * FROM plans WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!before) throw new NotFoundException('Plan not found');
      if (before.version !== dto.version)
        throw new ConflictException(
          'This plan changed. Reload before saving again.',
        );
      const [after] = await tx.query(
        `UPDATE plans SET monthly_cents=$2,annual_monthly_cents=$3,credits=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, dto.monthlyCents, dto.annualMonthlyCents, dto.credits],
      );
      await tx.query(
        `INSERT INTO admin_audit(actor_id,action,target_id,before_data,after_data) VALUES($1,'plan.update',$2,$3::jsonb,$4::jsonb)`,
        [actor, id, JSON.stringify(before), JSON.stringify(after)],
      );
      return { saved: true };
    });
  }
  async addTopUp(dto: TopUpDto, actor: string) {
    if (dto.note.trim().length < 3)
      throw new BadRequestException('Add a payment reference or reason');
    return this.db.transaction(async (tx) => {
      const [user] = await tx.query('SELECT id FROM users WHERE email=$1', [
        dto.email.trim().toLowerCase(),
      ]);
      if (!user)
        throw new NotFoundException('No account found with that email');
      const [entry] = await tx.query(
        `INSERT INTO top_ups(request_id,user_id,actor_id,amount_cents,credits,note) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id) DO NOTHING RETURNING id`,
        [
          dto.requestId,
          user.id,
          actor,
          dto.amountCents,
          dto.credits,
          dto.note.trim(),
        ],
      );
      if (!entry) {
        const [old] = await tx.query(
          'SELECT * FROM top_ups WHERE request_id=$1',
          [dto.requestId],
        );
        if (
          old.user_id !== user.id ||
          old.actor_id !== actor ||
          old.amount_cents !== dto.amountCents ||
          old.credits !== dto.credits ||
          old.note !== dto.note.trim()
        )
          throw new ConflictException(
            'This request was already used for a different top-up',
          );
        return { id: old.id, duplicate: true };
      }
      const updated = await tx.query(
        `UPDATE users SET credit_balance=credit_balance+$2,credit_value_usd=credit_value_usd+$3::numeric/100 WHERE id=$1 AND credit_balance<=2147483647-$2-(SELECT coalesce(sum(credits_reserved),0) FROM generation_jobs WHERE user_id=$1 AND billing_status='reserved') RETURNING id`,
        [user.id, dto.credits, dto.amountCents],
      );
      if (!updated[0]?.length)
        throw new BadRequestException('Account credit limit exceeded');
      await tx.query(
        `INSERT INTO admin_audit(actor_id,action,target_id,after_data) VALUES($1,'topup.create',$2,$3::jsonb)`,
        [
          actor,
          entry.id,
          JSON.stringify({
            userId: user.id,
            amountCents: dto.amountCents,
            credits: dto.credits,
            note: dto.note.trim(),
          }),
        ],
      );
      return entry;
    });
  }
}
