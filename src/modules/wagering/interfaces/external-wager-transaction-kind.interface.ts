import { WagerTransactionKindEnum } from "../enums/wager-transaction-kind.enum.js";

export type ExternalWagerTransactionKind =
  | WagerTransactionKindEnum.Bet
  | WagerTransactionKindEnum.Win
  | WagerTransactionKindEnum.Loss
  | WagerTransactionKindEnum.Refund
  | WagerTransactionKindEnum.Rollback;