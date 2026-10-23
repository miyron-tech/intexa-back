import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { DataSource } from 'typeorm';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
@Injectable()
export class PasswordResetService {
  constructor(private readonly db: DataSource) {}
  async request(email: string) {
    // Always the same public response, including unknown accounts and cooldown.
    await this.db.transaction(async tx => {
      const [user] = await tx.query('SELECT id FROM users WHERE email=$1 FOR UPDATE', [email.trim().toLowerCase()]);
      if (!user) return;
      const [recent] = await tx.query("SELECT 1 FROM password_resets WHERE user_id=$1 AND created_at>now()-interval '1 minute'", [user.id]);
      if (recent) return;
      const token = randomBytes(32).toString('base64url');
      await tx.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [hash(token), user.id]);
      await tx.query("INSERT INTO email_outbox(kind,user_id,payload) VALUES('password_reset',$1,$2::jsonb)", [user.id, JSON.stringify({token})]);
    });
    return { message: 'If an account exists for this email, you will receive a password reset link shortly.' };
  }
  async reset(token: string, password: string) {
    const invalid = () => new BadRequestException('This reset link is invalid or has expired. Request a new one.');
    const [candidate] = await this.db.query('SELECT user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()', [hash(token)]);
    if (!candidate) throw invalid();
    const passwordHash = await argon2.hash(password);
    await this.db.transaction(async tx => {
      // Serialize all reset links for the account, including concurrent requests.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [candidate.user_id]);
      const [valid] = await tx.query('SELECT user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE', [hash(token)]);
      if (!valid) throw invalid();
      await tx.query('UPDATE users SET password_hash=$2,password_changed_at=clock_timestamp(),updated_at=now() WHERE id=$1', [valid.user_id,passwordHash]);
      await tx.query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [valid.user_id]);
      await tx.query('UPDATE refresh_tokens SET revoked_at=now(),replaced_by_id=NULL WHERE user_id=$1', [valid.user_id]);
      await tx.query("UPDATE email_outbox SET status='failed',payload='{}',last_error='Reset completed' WHERE user_id=$1 AND kind='password_reset' AND status='pending'", [valid.user_id]);
      await tx.query("INSERT INTO email_outbox(kind,user_id) VALUES('password_changed',$1)", [valid.user_id]);
    });
    return { message: 'Your password has been changed. Sign in with your new password.' };
  }
}
