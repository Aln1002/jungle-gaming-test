import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  configuration,
  getEnvironmentFilePaths,
} from '../config/env/configuration.js';
import { getNestTypeOrmOptions } from './database/data-source-options.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MessagingModule } from './modules/messaging/messaging.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';
import { WageringModule } from './modules/wagering/wagering.module.js';
import { SharedModule } from './shared/shared.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: getEnvironmentFilePaths(),
      load: [configuration],
    }),
    SharedModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: getNestTypeOrmOptions,
    }),
    AuthModule,
    WageringModule,
    WalletsModule,
    MessagingModule,
    HealthModule,
  ],
})
export class AppModule {}
