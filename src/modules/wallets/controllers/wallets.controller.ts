import { Body, BadRequestException, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ProviderJwtAuthGuard } from '../../auth/guards/provider-jwt-auth.guard.js';
import { WalletService } from '../services/wallet.service.js';
import { CreateWalletDto } from '../dtos/create-wallet.dto.js';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

@ApiTags('Wallets')
@ApiBearerAuth()
@Controller('wallets')
@UseGuards(ProviderJwtAuthGuard)
export class WalletsController {
  constructor(private readonly walletService: WalletService) { }

  @Post()
  @ApiOperation({ summary: 'Create a wallet' })
  create(@Body() input: CreateWalletDto) {
    return this.walletService.createWallet(input);
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get a wallet and its balance' })
  get(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.walletService.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'List wallet ledger entries' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
    example: 50,
  })
  ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    if (
      limit !== undefined &&
      (typeof limit !== 'string' || !/^\d+$/.test(limit))
    ) {
      throw new BadRequestException({
        code: 'INVALID_LIMIT',
        message: 'Ledger limit must be an integer between 1 and 100',
      });
    }
    return this.walletService.getLedger(
      walletId,
      cursor,
      limit === undefined ? 50 : Number(limit),
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile the wallet balance against its ledger' })
  reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.walletService.reconcile(walletId);
  }
}
