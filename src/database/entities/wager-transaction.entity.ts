import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WagerTransactionKindEnum } from '../../modules/wagering/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../modules/wagering/enums/wager-transaction-status.enum.js';
import type { FailureCode } from '../../modules/wagering/enums/failure-code.enum.js';

@Entity({ name: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'varchar', length: 120 })
  providerId!: string;

  @Column({ name: 'external_transaction_id', type: 'varchar', length: 200 })
  externalTransactionId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ name: 'round_id', type: 'varchar', length: 200 })
  roundId!: string;

  @Column({ name: 'game_id', type: 'varchar', length: 200 })
  gameId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: WagerTransactionKindEnum;

  @Column({ name: 'money_amount', type: 'numeric', precision: 20, scale: 2 })
  moneyAmount!: string;

  @Column({ name: 'money_currency', type: 'varchar', length: 3 })
  moneyCurrency!: string;

  @Column({
    name: 'reference_external_transaction_id',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @Column({ type: 'varchar', length: 30 })
  status!: WagerTransactionStatus;

  @Column({ name: 'failure_code', type: 'varchar', length: 60, nullable: true })
  failureCode!: FailureCode | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 120 })
  correlationId!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({
    name: 'result_balance_amount',
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
  })
  resultBalanceAmount!: string | null;

  @Column({
    name: 'result_balance_currency',
    type: 'varchar',
    length: 3,
    nullable: true,
  })
  resultBalanceCurrency!: string | null;

  @Column({ name: 'pending_reference_attempts', type: 'integer', default: 0 })
  pendingReferenceAttempts!: number;

  @Column({
    name: 'next_reference_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  nextReferenceAttemptAt!: Date | null;
}
