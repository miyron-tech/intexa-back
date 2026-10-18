import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { User } from '../../users/entities/user.entity.js';
import type { ServiceId } from '../services.catalog.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobOutput {
  /** Путь относительно STORAGE_DIR */
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes: number;
}

@Entity('generation_jobs')
export class GenerationJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne('User', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 40 })
  service: ServiceId | 'character_swap';

  @Column({ type: 'varchar', length: 40 })
  preset: string;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status: JobStatus;

  /** Что ввёл пользователь: описание, площадка, длительность и прочее */
  @Column({ type: 'jsonb', default: {} })
  params: Record<string, unknown>;

  /** Итоговый англоязычный промпт, отправленный модели */
  @Column({ type: 'text', nullable: true })
  prompt: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  model: string | null;

  @Column({ type: 'jsonb', default: [] })
  outputs: JobOutput[];

  /** Себестоимость у провайдера — для контроля маржи */
  @Column({
    name: 'cost_usd',
    type: 'numeric',
    precision: 18,
    scale: 8,
    default: 0,
  })
  costUsd: string;

  @Column({ name: 'credits_reserved', type: 'integer', default: 0 })
  creditsReserved: number;
  @Column({ name: 'credits_charged', type: 'integer', default: 0 })
  creditsCharged: number;
  @Column({ name: 'reserved_value_usd', type: 'numeric', precision: 18, scale: 8, default: 0 })
  reservedValueUsd: string;
  @Column({ name: 'revenue_usd', type: 'numeric', precision: 18, scale: 8, default: 0 })
  revenueUsd: string;
  @Column({ name: 'billing_status', type: 'varchar', length: 20, default: 'legacy' })
  billingStatus: 'legacy' | 'reserved' | 'charged' | 'refunded';
  @Column({ name: 'request_id', type: 'uuid', nullable: true })
  requestId: string | null;
  @Column({ name: 'request_hash', type: 'varchar', length: 64, nullable: true })
  requestHash: string | null;
  @Column({ name: 'pricing_version', type: 'varchar', length: 30, nullable: true })
  pricingVersion: string | null;
  @Column({ name: 'remote_id', type: 'varchar', length: 200, nullable: true })
  remoteId: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
