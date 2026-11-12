import { WalletRepository } from '../../src/modules/wallets/repositories/wallet.repository.js';
import { LedgerRepository } from '../../src/modules/wallets/repositories/ledger.repository.js';
import { WagerTransactionRepository } from '../../src/modules/wagering/repositories/wager-transaction.repository.js';
import { InboxRepository } from '../../src/modules/messaging/repositories/inbox.repository.js';
import { OutboxRepository } from '../../src/modules/messaging/repositories/outbox.repository.js';
import { DataSource } from 'typeorm';
import { MetricsService } from '../../src/shared/observability/metrics.service.js';
import { StructuredLogger } from '../../src/shared/observability/structured-logger.js';
import { WalletService } from '../../src/modules/wallets/services/wallet.service.js';

export function createWageringRepositories(): [
  WalletRepository,
  LedgerRepository,
  WagerTransactionRepository,
  InboxRepository,
  OutboxRepository,
] {
  return [
    new WalletRepository(),
    new LedgerRepository(),
    new WagerTransactionRepository(),
    new InboxRepository(),
    new OutboxRepository(),
  ];
}

export function createWalletService(source: DataSource): WalletService {
  const [wallet, ledger, transactions, , outbox] = createWageringRepositories();
  return new WalletService(
    source,
    new MetricsService(),
    new StructuredLogger(),
    wallet,
    ledger,
    transactions,
    outbox,
  );
}
