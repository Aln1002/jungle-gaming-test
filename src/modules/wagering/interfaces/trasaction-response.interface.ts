import { MoneyProps } from "../../wallets/domain/money.js";
import { FailureCode } from "../enums/failure-code.enum.js";
import { WagerTransactionStatus } from "../enums/wager-transaction-status.enum.js";

export interface TransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}