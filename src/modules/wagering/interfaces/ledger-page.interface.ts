import { MoneyProps } from "../../wallets/domain/money.js";
import { LedgerDirection } from "../../wallets/enums/ledger-direction.enum.js";

export interface LedgerPage {
  items: Array<{
    id: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
  }>;
  nextCursor: string | null;
}