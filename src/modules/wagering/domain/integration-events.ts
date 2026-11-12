import { randomUUID } from 'node:crypto';
import { LedgerDirection } from '../../wallets/enums/ledger-direction.enum.js';
import type { MoneyProps } from '../../wallets/domain/money.js';
import { FailureCode } from '../enums/failure-code.enum.js';
import { WagerTransactionKindEnum } from '../enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.enum.js';
import { IntegrationEventEnvelope } from '../interfaces/integration-event-envelope.interface.js';

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  constructor(props: {
    eventId?: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt?: Date;
    data: T;
  }) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventEnvelope {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data },
    };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<{
  transactionId: string;
  providerId: string;
  walletId: string;
  kind: WagerTransactionKindEnum;
  status: WagerTransactionStatus.Processed;
}> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
}

export class WagerTransactionRejected extends IntegrationEvent<{
  transactionId: string;
  providerId: string;
  walletId: string;
  kind: WagerTransactionKindEnum;
  failureCode: FailureCode;
}> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
}

export class WagerTransactionFailed extends IntegrationEvent<{
  transactionId: string;
  providerId: string;
  walletId: string;
  kind: WagerTransactionKindEnum;
  failureCode: FailureCode;
}> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
}

export class WalletBalanceChanged extends IntegrationEvent<{
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
}

export class WagerTransactionPendingReference extends IntegrationEvent<{
  transactionId: string;
  providerId: string;
  walletId: string;
  referenceExternalTransactionId: string;
}> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
}
