export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.(\d{2})$/;
const MAX_MINOR_UNITS = 999_999_999_999_999_999_99n;
export const SUPPORTED_CURRENCIES = Intl.supportedValuesOf('currency');
const supportedCurrencies = new Set(SUPPORTED_CURRENCIES);

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!supportedCurrencies.has(props.currency)) {
      throw new Error('Currency must be a supported ISO-4217 code');
    }

    if (typeof props.amount !== 'string') {
      throw new Error('Amount must be a decimal string');
    }
    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new Error(
        'Amount must be a non-negative decimal string with two places',
      );
    }

    const minorUnits = BigInt(match[1]) * 100n + BigInt(match[2]);
    if (minorUnits > MAX_MINOR_UNITS) {
      throw new Error('Amount exceeds the supported precision');
    }
    return new Money(minorUnits, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  static rehydrate(minorUnits: bigint, currency: string): Money {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Currency must be an uppercase ISO-4217 code');
    }
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new Error('Amount exceeds the supported precision');
    }
    return new Money(minorUnits, currency);
  }

  static fromStored(amount: string, currency: string): Money {
    const match = /^(-?)(0|[1-9]\d*)\.(\d{2})$/.exec(amount);
    if (!match) {
      throw new Error('Stored amount is not a fixed-scale decimal');
    }
    const absolute = BigInt(match[2]) * 100n + BigInt(match[3]);
    return Money.rehydrate(match[1] === '-' ? -absolute : absolute, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.rehydrate(this.minorUnits + other.minorUnits, this.currency);
  }

  canAdd(other: Money): boolean {
    this.assertSameCurrency(other);
    const sum = this.minorUnits + other.minorUnits;
    return sum <= MAX_MINOR_UNITS && sum >= -MAX_MINOR_UNITS;
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.rehydrate(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.rehydrate(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const amount = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
    return negative ? `-${amount}` : amount;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
      );
    }
  }
}
