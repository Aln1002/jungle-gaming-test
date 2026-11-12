import { Money } from '../../wallets/domain/money.js';
import { LedgerDirection } from '../../wallets/enums/ledger-direction.enum.js';
import { WagerTransactionKindEnum } from '../enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.enum.js';
import type { FailureCode } from '../enums/failure-code.enum.js';
import { WagerTransactionState } from '../interfaces/wager-transaction-state.interface.js';



export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKindEnum,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) { }

  static create(state: Omit<WagerTransactionState, 'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'>): WagerTransaction {
    if (state.kind === WagerTransactionKindEnum.Opening) {
      throw new Error('Opening transactions are internal');
    }
    const hasReference = Boolean(state.referenceExternalTransactionId);
    if (
      ([WagerTransactionKindEnum.Refund, WagerTransactionKindEnum.Rollback].includes(
        state.kind,
      ) &&
        !hasReference) ||
      (hasReference &&
        ![
          WagerTransactionKindEnum.Win,
          WagerTransactionKindEnum.Refund,
          WagerTransactionKindEnum.Rollback,
        ].includes(state.kind))
    ) {
      throw new Error(
        'Refund and rollback require a reference; only WIN may also include one',
      );
    }
    if (!state.money.isPositive()) {
      throw new Error('Transaction amount must be positive');
    }
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertPending();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertPending();
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertPending();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertPending();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKindEnum.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKindEnum.Refund ||
      this.kind === WagerTransactionKindEnum.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(
    referenceDirection?: LedgerDirection,
  ): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKindEnum.Opening:
      case WagerTransactionKindEnum.Win:
      case WagerTransactionKindEnum.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKindEnum.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKindEnum.Loss:
        return undefined;
      case WagerTransactionKindEnum.Rollback:
        if (!referenceDirection) {
          throw new Error('Rollback direction requires a processed reference');
        }
        return referenceDirection === LedgerDirection.Credit
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
    }
  }

  private assertPending(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new Error(`Cannot transition transaction from ${this._status}`);
    }
  }
}
