import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { InboxMessageEntity } from './entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './entities/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from './entities/wallet.entity.js';
import { WagerTransactionEntity } from './entities/wager-transaction.entity.js';
import { CreateWageringSchema1730000000000 } from './migrations/1730000000000-CreateWageringSchema.js';
import { PreventCrossTypeReversals1730000000001 } from './migrations/1730000000001-PreventCrossTypeReversals.js';
import { ProtectMonetaryValues1730000000002 } from './migrations/1730000000002-ProtectMonetaryValues.js';
import { AddOutboxLeaseToken1730000000003 } from './migrations/1730000000003-AddOutboxLeaseToken.js';
import { AllowWinReference1730000000004 } from './migrations/1730000000004-AllowWinReference.js';
import { getEnvironment } from '../../config/env/configuration.js';
import { EnvironmentGlobalsEnum } from '../shared/enums/environment-globals.enum.js';

const entities = [
  WalletEntity,
  WagerTransactionEntity,
  WalletLedgerEntryEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
];

export function getDataSourceOptions(): Extract<
  DataSourceOptions,
  { type: 'postgres' }
> {
  const environment = getEnvironment();
  return {
    type: 'postgres',
    url: environment.database.url,
    ssl: environment.database.ssl ? { rejectUnauthorized: true } : false,
    entities,
    migrations: [
      CreateWageringSchema1730000000000,
      PreventCrossTypeReversals1730000000001,
      ProtectMonetaryValues1730000000002,
      AddOutboxLeaseToken1730000000003,
      AllowWinReference1730000000004,
    ],
    migrationsTableName: 'schema_migrations',
    synchronize: false,
    migrationsRun: true,
  };
}

export function getNestTypeOrmOptions(
  configService: ConfigService,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    url: configService.getOrThrow<string>(EnvironmentGlobalsEnum.DatabaseUrl),
    ssl: configService.get<boolean>(EnvironmentGlobalsEnum.DatabaseSsl)
      ? { rejectUnauthorized: true }
      : false,
    entities,
    migrations: [
      CreateWageringSchema1730000000000,
      PreventCrossTypeReversals1730000000001,
      ProtectMonetaryValues1730000000002,
      AddOutboxLeaseToken1730000000003,
      AllowWinReference1730000000004,
    ],
    migrationsTableName: 'schema_migrations',
    synchronize: false,
    migrationsRun: true,
    autoLoadEntities: true,
    retryAttempts: 5,
    retryDelay: 1_000,
  };
}
