import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { InboxMessageEntity } from '../../database/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../../database/entities/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from '../../database/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
import { WageringService } from './services/wagering.service.js';
import { TransactionQueriesController } from './controllers/transaction-queries.controller.js';
import { WageringController } from './controllers/wagering.controller.js';
import { WalletRepository } from '../wallets/repositories/wallet.repository.js';
import { LedgerRepository } from '../wallets/repositories/ledger.repository.js';
import { WagerTransactionRepository } from './repositories/wager-transaction.repository.js';
import { InboxRepository } from '../messaging/repositories/inbox.repository.js';
import { OutboxRepository } from '../messaging/repositories/outbox.repository.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ]),
  ],
  controllers: [WageringController, TransactionQueriesController],
  providers: [
    WageringService,
    WalletRepository,
    LedgerRepository,
    WagerTransactionRepository,
    InboxRepository,
    OutboxRepository,
  ],
  exports: [
    WageringService,
    WalletRepository,
    LedgerRepository,
    WagerTransactionRepository,
    OutboxRepository,
  ],
})
export class WageringModule {}
