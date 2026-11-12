import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/modules/wallets/domain/money.js';
import { Wallet } from '../../src/modules/wallets/domain/wallet.js';

describe('Money', () => {
  it('uses exact integer arithmetic and fixed-scale serialization', () => {
    const first = Money.from({
      amount: '999999999999999999.99',
      currency: 'BRL',
    });
    const second = Money.from({ amount: '0.01', currency: 'BRL' });

    expect(() =>
      first.add(Money.from({ amount: '0.01', currency: 'USD' })),
    ).toThrow('Currency mismatch');
    expect(
      second.add(Money.from({ amount: '0.01', currency: 'BRL' })).toJSON(),
    ).toEqual({
      amount: '0.02',
      currency: 'BRL',
    });
    expect(first.toJSON()).toEqual({
      amount: '999999999999999999.99',
      currency: 'BRL',
    });
  });

  it.each(['1', '1.2', '1.234', '-1.00', '1e2', 'NaN', 'Infinity', ''])(
    'rejects invalid external amount %s',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    },
  );

  it('rejects arithmetic across currencies and supports signed differences', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow('Currency mismatch');
    expect(
      brl.subtract(Money.from({ amount: '2.00', currency: 'BRL' })).toString(),
    ).toBe('-1.00');
    expect(brl.negate().toString()).toBe('-1.00');
  });

  it('accepts supported currencies and rejects unknown currency codes', () => {
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).currency).toBe(
      'BRL',
    );
    expect(Money.from({ amount: '1.00', currency: 'USD' }).currency).toBe(
      'USD',
    );
    expect(() => Money.from({ amount: '1.00', currency: 'ZZZ' })).toThrow();
  });

  it('does not coerce numeric amounts into monetary strings', () => {
    const invalid = JSON.parse('{"amount":1.23,"currency":"BRL"}') as {
      amount: string;
      currency: string;
    };
    expect(() => Money.from(invalid)).toThrow('decimal string');
  });

  it('keeps operands immutable across operations and rehydrates exact signed values', () => {
    const amount = Money.from({ amount: '25.00', currency: 'BRL' });
    const other = Money.from({ amount: '0.01', currency: 'BRL' });
    const sum = amount.add(other);
    const difference = amount.subtract(other);
    const negated = amount.negate();
    expect(sum).not.toBe(amount);
    expect(difference).not.toBe(amount);
    expect(negated).not.toBe(amount);
    expect(amount.toString()).toBe('25.00');
    expect(other.toString()).toBe('0.01');
    expect(sum.toString()).toBe('25.01');
    expect(difference.toString()).toBe('24.99');
    expect(negated.toString()).toBe('-25.00');
    expect(Money.fromStored('-25.00', 'BRL').equals(negated)).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(negated.isNegative()).toBe(true);
    expect(other.isLessThan(amount)).toBe(true);
    expect(() =>
      amount.subtract(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow('Currency mismatch');
    expect(() =>
      amount.equals(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow('Currency mismatch');
    expect(() =>
      amount.isLessThan(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow('Currency mismatch');
  });
});

describe('Wallet', () => {
  const wallet = () =>
    Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

  it('increments the version only when a balance changes', () => {
    const account = wallet();

    expect(account.version).toBe(1);
    account.debit(Money.from({ amount: '25.00', currency: 'BRL' }));
    expect(account.balance.toString()).toBe('75.00');
    expect(account.version).toBe(2);
  });

  it('rejects negative balances and currency conflicts', () => {
    const account = wallet();

    expect(() =>
      account.debit(Money.from({ amount: '100.01', currency: 'BRL' })),
    ).toThrow('Insufficient funds');
    expect(() =>
      account.credit(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow('Currency mismatch');
    expect(account.balance.toString()).toBe('100.00');
    expect(account.version).toBe(1);
  });
});
