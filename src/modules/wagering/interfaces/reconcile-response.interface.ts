import { MoneyProps } from "../../wallets/domain/money.js";

export interface ReconcileResponse {
    walletId: string;
    storedBalance: MoneyProps;
    calculatedBalance: MoneyProps;
    difference: MoneyProps;
    consistent: boolean;
    checkedEntries: number;
}