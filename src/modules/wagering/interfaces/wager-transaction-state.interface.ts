import { Money } from "../../wallets/domain/money.js";
import { FailureCode } from "../enums/failure-code.enum.js";
import { WagerTransactionKindEnum } from "../enums/wager-transaction-kind.enum.js";
import { WagerTransactionStatus } from "../enums/wager-transaction-status.enum.js";

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKindEnum;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}