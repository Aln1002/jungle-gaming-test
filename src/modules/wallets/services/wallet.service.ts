import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WalletEntity } from '../../../database/entities/wallet.entity.js';
import { isTransientDatabaseError, isUniqueViolation, serviceUnavailable } from '../../../shared/errors/domain-errors.js';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { StructuredLogger } from '../../../shared/observability/structured-logger.js';
import { hashPayload } from '../../../shared/utils/payload-hash.util.js';
import { OutboxRepository } from '../../messaging/repositories/outbox.repository.js';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../../wagering/domain/integration-events.js';
import { FailureCode } from '../../wagering/enums/failure-code.enum.js';
import { WagerTransactionKindEnum } from '../../wagering/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../wagering/enums/wager-transaction-status.enum.js';
import type { LedgerPage } from '../../wagering/interfaces/ledger-page.interface.js';
import type { ReconcileResponse } from '../../wagering/interfaces/reconcile-response.interface.js';
import type { WalletResponse } from '../../wagering/interfaces/wallet-response.interface.js';
import { WagerTransactionRepository } from '../../wagering/repositories/wager-transaction.repository.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { CreateWalletDto } from '../dtos/create-wallet.dto.js';
import { LedgerDirection } from '../enums/ledger-direction.enum.js';
import { LedgerRepository } from '../repositories/ledger.repository.js';
import { WalletRepository } from '../repositories/wallet.repository.js';
import { decodeCursor, encodeCursor } from '../../../shared/utils/cursor.util.js';

@Injectable()
export class WalletService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
    private readonly walletRepository: WalletRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly outboxRepository: OutboxRepository,
  ) { }

  async createWallet(dto: CreateWalletDto): Promise<WalletResponse> {
    const initialBalance = Money.from(dto.initialBalance);
    if (initialBalance.isNegative()) {
      throw new BadRequestException({
        code: 'INVALID_INITIAL_BALANCE',
        message: 'Initial balance cannot be negative',
      });
    }

    const id = randomUUID();
    const now = new Date();
    const wallet = Wallet.open({
      id,
      playerId: dto.playerId,
      initialBalance,
      now,
    });

    try {
      await this.dataSource.transaction(async (manager) => {
        await this.walletRepository.insert(manager, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });

        if (initialBalance.isPositive()) {
          const openingTransactionId = randomUUID();
          const money = initialBalance.toJSON();
          const opening = this.wagerTransactionRepository.create(manager, {
            id: openingTransactionId,
            providerId: 'internal',
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: hashPayload({ walletId: wallet.id, money }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'internal',
            kind: WagerTransactionKindEnum.Opening,
            moneyAmount: money.amount,
            moneyCurrency: money.currency,
            referenceExternalTransactionId: null,
            referenceTransactionId: null,
            status: WagerTransactionStatus.Processed,
            failureCode: null,
            correlationId: openingTransactionId,
            createdAt: now,
            processedAt: now,
            resultBalanceAmount: wallet.balance.toString(),
            resultBalanceCurrency: wallet.currency,
            pendingReferenceAttempts: 0,
            nextReferenceAttemptAt: null,
          });
          await this.wagerTransactionRepository.save(manager, opening);

          const entry = WalletLedgerEntry.create({
            walletId: wallet.id,
            transactionId: openingTransactionId,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initialBalance,
            createdAt: now,
          });
          await this.ledgerRepository.insert(manager, entry, wallet.version);
          await this.outboxRepository.enqueue(
            manager,
            new WagerTransactionProcessed({
              aggregateId: wallet.id,
              correlationId: openingTransactionId,
              causationId: openingTransactionId,
              occurredAt: now,
              data: {
                transactionId: openingTransactionId,
                providerId: 'internal',
                walletId: wallet.id,
                kind: WagerTransactionKindEnum.Opening,
                status: WagerTransactionStatus.Processed,
              },
            }),
          );
          await this.outboxRepository.enqueue(
            manager,
            new WalletBalanceChanged({
              aggregateId: wallet.id,
              correlationId: openingTransactionId,
              causationId: openingTransactionId,
              occurredAt: now,
              data: {
                walletId: wallet.id,
                transactionId: openingTransactionId,
                direction: LedgerDirection.Credit,
                money: initialBalance.toJSON(),
                balanceBefore: Money.zero(wallet.currency).toJSON(),
                balanceAfter: initialBalance.toJSON(),
                walletVersion: wallet.version,
              },
            }),
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'WALLET_ALREADY_EXISTS',
          message: 'A wallet already exists for this player and currency',
        });
      }
      if (isTransientDatabaseError(error)) {
        throw serviceUnavailable(
          'The wallet could not be persisted; retry the request',
        );
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async getWallet(walletId: string): Promise<WalletResponse> {
    const wallet = await this.walletRepository.findById(this.dataSource.manager, walletId);
    if (!wallet) {
      throw new NotFoundException({
        code: FailureCode.WalletNotFound,
        message: 'Wallet not found',
      });
    }
    return this.walletResponse(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({
        code: 'INVALID_LIMIT',
        message: 'Ledger limit must be an integer between 1 and 100',
      });
    }

    await this.getWallet(walletId);

    const rows = await this.ledgerRepository.findPage(
      this.dataSource.manager,
      walletId,
      limit,
      cursor ? decodeCursor(cursor) : undefined,
    );

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);

    return {
      items: pageRows.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: Money.fromStored(entry.amount, entry.currency).toJSON(),
        balanceBefore: Money.fromStored(entry.balanceBefore, entry.currency).toJSON(),
        balanceAfter: Money.fromStored(entry.balanceAfter, entry.currency).toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  async reconcile(walletId: string): Promise<ReconcileResponse> {
    const snapshot = await this.walletRepository.reconcile(this.dataSource.manager, walletId);
    if (!snapshot) {
      throw new NotFoundException({
        code: FailureCode.WalletNotFound,
        message: 'Wallet not found',
      });
    }
    const storedBalance = Money.fromStored(snapshot.stored_balance, snapshot.currency);
    const calculatedBalance = Money.fromStored(snapshot.calculated_balance, snapshot.currency);
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.increment('reconciliation_mismatches');
      this.logger.error({
        event: 'wallet_reconciliation_mismatch',
        walletId,
        checkedEntries: snapshot.entries,
      });
    }
    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
    };
  }

  private walletResponse(entity: WalletEntity): WalletResponse {
    return {
      id: entity.id,
      playerId: entity.playerId,
      balance: Money.fromStored(entity.balance, entity.currency).toJSON(),
      version: entity.version,
    };
  }

}
