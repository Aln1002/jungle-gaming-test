import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WageringModule } from '../wagering/wagering.module.js';
import { WalletsController } from './controllers/wallets.controller.js';
import { WalletService } from './services/wallet.service.js';

@Module({
  imports: [AuthModule, WageringModule],
  controllers: [WalletsController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletsModule {}
