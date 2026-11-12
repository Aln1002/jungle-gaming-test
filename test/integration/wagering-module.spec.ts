import { describe, expect, it } from 'bun:test';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { WageringModule } from '../../src/modules/wagering/wagering.module.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import { WalletsModule } from '../../src/modules/wallets/wallets.module.js';
import { WalletService } from '../../src/modules/wallets/services/wallet.service.js';
import { WalletRepository } from '../../src/modules/wallets/repositories/wallet.repository.js';
import { LedgerRepository } from '../../src/modules/wallets/repositories/ledger.repository.js';
import { WagerTransactionRepository } from '../../src/modules/wagering/repositories/wager-transaction.repository.js';
import { InboxRepository } from '../../src/modules/messaging/repositories/inbox.repository.js';
import { OutboxRepository } from '../../src/modules/messaging/repositories/outbox.repository.js';
import { SharedModule } from '../../src/shared/shared.module.js';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService({
        auth: {
          issuerUrl: 'http://localhost:8080/realms/wagering',
          jwksUrl: 'http://localhost:8080/realms/wagering/certs',
          audience: 'wagering-api',
          providerIdClaim: 'providerId',
        },
      }),
    },
    {
      provide: DataSource,
      useValue: {
        options: { type: 'postgres' },
        entityMetadatas: [],
        getRepository: () => ({}),
      },
    },
  ],
  exports: [ConfigService, DataSource],
})
class TestInfrastructureModule {}

@Module({
  imports: [TestInfrastructureModule, SharedModule, WageringModule, WalletsModule],
})
class TestApplicationModule {}

describe('WageringModule dependency injection', () => {
  it('resolves WageringService and all its repositories through Nest', async () => {
    const app = await NestFactory.createApplicationContext(
      TestApplicationModule,
      {
        logger: false,
        abortOnError: false,
      },
    );
    try {
      expect(app.get(WageringService)).toBeInstanceOf(WageringService);
      expect(app.get(WalletService)).toBeInstanceOf(WalletService);
      expect(app.get(WalletRepository)).toBeInstanceOf(WalletRepository);
      expect(app.get(LedgerRepository)).toBeInstanceOf(LedgerRepository);
      expect(app.get(WagerTransactionRepository)).toBeInstanceOf(
        WagerTransactionRepository,
      );
      expect(app.get(InboxRepository)).toBeInstanceOf(InboxRepository);
      expect(app.get(OutboxRepository)).toBeInstanceOf(OutboxRepository);
    } finally {
      await app.close();
    }
  });
});
