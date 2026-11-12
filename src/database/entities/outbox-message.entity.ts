import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { IntegrationEventEnvelope } from '../../modules/wagering/interfaces/integration-event-envelope.interface.js';

@Entity({ name: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: IntegrationEventEnvelope;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'dead_lettered_at', type: 'timestamptz', nullable: true })
  deadLetteredAt!: Date | null;
}
