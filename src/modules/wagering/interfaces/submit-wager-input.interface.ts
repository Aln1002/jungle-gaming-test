import { MoneyProps } from "../../wallets/domain/money.js";
import { ExternalWagerTransactionKind } from "./external-wager-transaction-kind.interface.js";

export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}