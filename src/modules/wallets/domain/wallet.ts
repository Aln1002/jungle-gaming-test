import { WalletState } from '../interfaces/wallet-state.interface.js';
import { Money } from './money.js';

export class Wallet {
  
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) { }

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.currency.length !== 3) {
      throw new Error('Wallet currency must be an ISO-4217 code');
    }
    if (!props.initialBalance.isZero() && !props.initialBalance.isPositive()) {
      throw new Error('Initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    if (state.currency !== state.balance.currency) {
      throw new Error('Wallet balance currency does not match the wallet');
    }
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(
    amount: Money,
    at = new Date(),
  ): {
    balanceBefore: Money;
    balanceAfter: Money;
    version: number;
  } {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new Error('Debit amount must be positive');
    }
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(amount);
    if (balanceAfter.isNegative()) {
      throw new Error('Insufficient funds');
    }
    this.applyBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, version: this._version };
  }

  credit(amount: Money, at = new Date(),): { balanceBefore: Money; balanceAfter: Money; version: number; } {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new Error('Credit amount must be positive');
    }
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(amount);
    this.applyBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, version: this._version };
  }

  private applyBalance(balance: Money, at: Date): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) {
      throw new Error(`Currency mismatch: wallet uses ${this.currency}`);
    }
  }
}
