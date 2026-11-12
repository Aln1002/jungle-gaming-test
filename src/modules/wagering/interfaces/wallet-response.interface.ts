import { MoneyProps } from "../../wallets/domain/money.js";

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}