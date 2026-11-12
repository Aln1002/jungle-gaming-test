import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/modules/wallets/domain/money.js';
import { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry.js';
import { LedgerDirection } from '../../src/modules/wallets/enums/ledger-direction.enum.js';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.js';
import { WagerTransactionKindEnum } from '../../src/modules/wagering/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/enums/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/modules/wagering/enums/failure-code.enum.js';

describe('WagerTransaction', () => {
  const createBet = () =>
    WagerTransaction.create({
      id: 'transaction-id',
      providerId: 'provider-a',
      externalTransactionId: 'external-transaction',
      idempotencyKey: 'key',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-id',
      gameId: 'game-id',
      kind: WagerTransactionKindEnum.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

  it('keeps state transitions explicit and terminal', () => {
    const transaction = createBet();
    transaction.markProcessed(undefined, new Date());

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject(FailureCode.InsufficientFunds)).toThrow(
      'Cannot transition',
    );
  });

  it('marks a transaction as failed and forbids all subsequent transitions', () => {
    const transaction = createBet();
    transaction.fail(FailureCode.InvalidTransaction);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.InvalidTransaction);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed(undefined, new Date())).toThrow(
      'Cannot transition',
    );
    expect(() => transaction.markPendingReference()).toThrow(
      'Cannot transition',
    );
    expect(() => transaction.reject(FailureCode.InsufficientFunds)).toThrow(
      'Cannot transition',
    );
    expect(() => transaction.fail(FailureCode.InvalidTransaction)).toThrow(
      'Cannot transition',
    );
  });

  it('requires references for reversals and keeps opening internal', () => {
    const props = {
      id: 'transaction-id',
      providerId: 'provider-a',
      externalTransactionId: 'external-transaction',
      idempotencyKey: 'key',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-id',
      gameId: 'game-id',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date(),
    };

    expect(() =>
      WagerTransaction.create({ ...props, kind: WagerTransactionKindEnum.Refund }),
    ).toThrow('require a reference');
    expect(() =>
      WagerTransaction.create({ ...props, kind: WagerTransactionKindEnum.Opening }),
    ).toThrow('internal');
  });

  it('derives rollback direction from the referenced ledger entry', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'transaction-id',
      providerId: 'provider-a',
      externalTransactionId: 'external-transaction',
      idempotencyKey: 'key',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-id',
      gameId: 'game-id',
      kind: WagerTransactionKindEnum.Rollback,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'reference-id',
      createdAt: new Date(),
      status: WagerTransactionStatus.Pending,
    });

    expect(transaction.ledgerDirectionFor(LedgerDirection.Debit)).toBe(
      LedgerDirection.Credit,
    );
    expect(transaction.ledgerDirectionFor(LedgerDirection.Credit)).toBe(
      LedgerDirection.Debit,
    );
    expect(() => transaction.ledgerDirectionFor()).toThrow(
      'requires a processed reference',
    );
  });
});

describe('WalletLedgerEntry', () => {
  it('validates balance arithmetic when creating an immutable entry', () => {
    const common = {
      walletId: 'wallet-id',
      transactionId: 'transaction-id',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '20.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
    };
    const entry = WalletLedgerEntry.create({
      ...common,
      direction: LedgerDirection.Debit,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({
        ...common,
        direction: LedgerDirection.Credit,
      }),
    ).toThrow('does not balance');
  });
});
