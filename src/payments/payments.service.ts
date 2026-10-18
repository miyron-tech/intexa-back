import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DataSource } from 'typeorm';
import { quoteCustomPackage } from './custom-package.js';

export function validSignature(body: Buffer, signature: string | undefined, key: string): boolean {
  if (!signature) return false;
  const value = signature.trim();
  const expected = createHmac('sha256', key).update(body).digest();
  const received = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
  async profile(userId: string) {
    const [profile] = await this.db.query('SELECT details FROM billing_profiles WHERE user_id=$1', [userId]);
    return profile?.details ?? null;
  }
  list(userId: string) {
    return this.db.query(`SELECT id,plan_name AS "planName",amount_cents AS "amountCents",credits,currency,status,created_at AS "createdAt" FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [userId]);
  }
  async checkout(userId: string, planId: string, details: { customAmountCents?: number; email?: string; firstName: string; lastName: string; addressLine1: string; city: string; countryCode: string; postalCode: string }) {
    const key = this.config.get<string>('WEMOPAY_API_KEY');
    const apiUrl = this.config.get<string>('WEMOPAY_API_URL');
    if (!key || !apiUrl || !this.config.get('WEMOPAY_SIGNING_KEY')) throw new ServiceUnavailableException('Online payments are temporarily unavailable. Please try again later.');
    const plan = planId === 'custom'
      ? quoteCustomPackage(details.customAmountCents)
      : (await this.db.query('SELECT * FROM plans WHERE id=$1', [planId]))[0];
    if (!plan || plan.monthly_cents <= 0 || plan.credits <= 0) throw new BadRequestException('Choose a paid credit package');
    const [user] = await this.db.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!user) throw new NotFoundException('Account not found');
    const email = (details.email ?? user.email).trim();
    if (!isEmail(email) || /\.(local|localhost|test|invalid|example|internal|lan)$/i.test(email)) {
      throw new BadRequestException('Enter a valid payment email address. Addresses ending in .local or other test-only domains cannot be used for payment. Your sign-in email will stay the same.');
    }
    const billing = {
      email,
      firstName: details.firstName.trim(), lastName: details.lastName.trim(),
      addressLine1: details.addressLine1.trim(), city: details.city.trim(),
      countryCode: details.countryCode.trim().toUpperCase(), postalCode: details.postalCode.trim(),
    };
    if (Object.values(billing).some(value => !value)) throw new BadRequestException('Complete your billing details');
    await this.db.query(`INSERT INTO billing_profiles(user_id,details) VALUES($1,$2::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET details=EXCLUDED.details,updated_at=now()`, [userId, JSON.stringify(billing)]);
    details = billing;
    const id = randomUUID();
    await this.db.query(`INSERT INTO payments(id,user_id,plan_id,plan_name,amount_cents,credits) VALUES($1,$2,$3,$4,$5,$6)`, [id,userId,plan.id,plan.name,plan.monthly_cents,plan.credits]);
    const origin = this.config.get<string>('FRONTEND_URL')!.replace(/\/$/, '');
    let result: { id: string; redirectUrl: string };
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/payments`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ paymentType: 'DEPOSIT', paymentMethod: 'BASIC_CARD', amount: plan.monthly_cents / 100, currency: 'USD', referenceId: id,
          returnUrl: `${origin}/dashboard/billing?payment=${id}`, webhookUrl: `${origin}/api/payments/wemopay/webhook`, customer: { email, firstName: details.firstName, lastName: details.lastName },
          billingAddress: { addressLine1: details.addressLine1, city: details.city, countryCode: details.countryCode, postalCode: details.postalCode } }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const fields: string[] = Array.isArray(error.errors) ? error.errors.map((item: { field?: unknown }) => typeof item.field === 'string' ? item.field : '').filter(Boolean) : [];
        this.logger.warn(`Checkout ${id}: provider HTTP ${response.status}; invalid fields: ${fields.filter(field => /^[a-zA-Z.]{1,80}$/.test(field)).join(', ') || 'unspecified'}`);
        if ((response.status === 400 || response.status === 422) && fields.length) {
          await this.db.query("UPDATE payments SET status='failed',updated_at=now() WHERE id=$1 AND status='pending'", [id]);
          if (fields.includes('customer.email')) throw new BadRequestException('Wemopay could not accept this payment email. Edit your billing details and enter a valid email address, then try again.');
          const labels: Record<string,string> = { 'customer.firstName':'first name', 'customer.lastName':'last name', 'billingAddress.addressLine1':'billing address', 'billingAddress.city':'city', 'billingAddress.countryCode':'country code', 'billingAddress.postalCode':'postal code' };
          const names = fields.map(field => labels[field]).filter(Boolean);
          throw new BadRequestException(`Please check your ${names.length ? names.join(', ') : 'billing details'} and try again.`);
        }
        throw new Error('Provider rejected checkout');
      }
      ({ result } = await response.json());
      if (!result?.id || new URL(result.redirectUrl).protocol !== 'https:') throw new Error('Invalid provider response');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // Keep pending: a timeout can happen after the provider creates the payment.
      throw new BadGatewayException('Could not open the payment page. Please try again.');
    }
    await this.db.query('UPDATE payments SET provider_id=$2,redirect_url=$3,updated_at=now() WHERE id=$1', [id,result.id,result.redirectUrl]);
    return { id, redirectUrl: result.redirectUrl };
  }
  async webhook(raw: Buffer | undefined, signature?: string) {
    const key = this.config.get<string>('WEMOPAY_SIGNING_KEY');
    if (!key) throw new ServiceUnavailableException('Webhook is not configured');
    if (!raw || !validSignature(raw, signature, key)) throw new UnauthorizedException('Invalid signature');
    let p: Record<string, unknown>;
    try { p = JSON.parse(raw.toString('utf8')); } catch { throw new BadRequestException('Invalid payload'); }
    if (!p || typeof p.id !== 'string' || typeof p.referenceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.referenceId) || typeof p.state !== 'string') throw new BadRequestException('Invalid payload');
    if (p.paymentType !== 'DEPOSIT') return { received: true };
    return this.db.transaction(async tx => {
      const [order] = await tx.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [p.referenceId]);
      if (!order) throw new NotFoundException('Payment not found');
      if (order.provider_id && order.provider_id !== p.id) throw new BadRequestException('Payment ID mismatch');
      if (order.status !== 'pending') return { received: true };
      const status = { COMPLETED: 'completed', DECLINED: 'failed', CANCELLED: 'cancelled' }[p.state as string];
      if (!status) return { received: true };
      if (status === 'completed') {
        if (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || Math.abs(p.amount * 100 - order.amount_cents) > 0.001 || p.currency !== order.currency) throw new BadRequestException('Payment amount mismatch');
        await tx.query(`INSERT INTO top_ups(request_id,user_id,actor_id,amount_cents,credits,note) VALUES($1,$2,$2,$3,$4,$5)`, [order.id,order.user_id,order.amount_cents,order.credits,`Wemopay ${p.id} · ${order.plan_name}`]);
        await tx.query('UPDATE users SET credit_balance=credit_balance+$2,credit_value_usd=credit_value_usd+$3::numeric/100 WHERE id=$1', [order.user_id,order.credits,order.amount_cents]);
      }
      await tx.query('UPDATE payments SET status=$2,provider_id=$3,updated_at=now() WHERE id=$1', [order.id,status,p.id]);
      return { received: true };
    });
  }
}
