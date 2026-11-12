import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { WalletEntity } from '../../../database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../../database/entities/wager-transaction.entity.js';
import { IdempotencyConflictError, PermanentMessageError, isDatabasePermissionDenied, isDatabaseLockConflict, isTransientDatabaseError, isUniqueViolation, serviceUnavailable } from '../../../shared/errors/domain-errors.js';
import { hashPayload } from '../../../shared/utils/payload-hash.util.js';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { StructuredLogger } from '../../../shared/observability/structured-logger.js';
import { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry.js';
import { LedgerDirection } from '../../wallets/enums/ledger-direction.enum.js';
import { Money } from '../../wallets/domain/money.js';
import { Wallet } from '../../wallets/domain/wallet.js';
import { InboxMessage } from '../../messaging/domain/inbox-message.js';
import { WalletBalanceChanged, WagerTransactionFailed, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../domain/integration-events.js';
import type { IntegrationEvent } from '../domain/integration-events.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { FailureCode } from '../enums/failure-code.enum.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.enum.js';
import { EnvironmentGlobalsEnum } from '../../../shared/enums/environment-globals.enum.js';
import { WagerTransactionKindEnum } from '../enums/wager-transaction-kind.enum.js';
import { SubmitWagerInput } from '../interfaces/submit-wager-input.interface.js';
import { SubmitContext } from '../interfaces/submit-interface-context.interface.js';
import { TransactionResponse } from '../interfaces/trasaction-response.interface.js';
import { WalletRepository } from '../../wallets/repositories/wallet.repository.js';
import { LedgerRepository } from '../../wallets/repositories/ledger.repository.js';
import { WagerTransactionRepository } from '../repositories/wager-transaction.repository.js';
import { InboxRepository } from '../../messaging/repositories/inbox.repository.js';
import { OutboxRepository } from '../../messaging/repositories/outbox.repository.js';
import { RolledBackPermissionDeniedError } from '../../../shared/errors/rolled-back-permission-denied-error.js';


@Injectable()
export class WageringService {

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
    private readonly configService: ConfigService,
    private readonly walletRepository: WalletRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly inboxRepository: InboxRepository,
    private readonly outboxRepository: OutboxRepository,
  ) { }



  async submit(input: SubmitWagerInput, idempotencyKey: string, context: SubmitContext = {}): Promise<TransactionResponse | null> {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must contain between 1 and 255 characters',
      });
    }
    const money = Money.from(input.money);
    if (!money.isPositive()) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: 'Transaction amount must be greater than zero',
      });
    }
    const hasReference = Boolean(input.referenceExternalTransactionId);
    if (
      ([
        WagerTransactionKindEnum.Refund,
        WagerTransactionKindEnum.Rollback,
      ].includes(input.kind) &&
        !hasReference) ||
      (hasReference &&
        ![
          WagerTransactionKindEnum.Win,
          WagerTransactionKindEnum.Refund,
          WagerTransactionKindEnum.Rollback,
        ].includes(input.kind))
    ) {
      throw new BadRequestException({
        code: 'REFERENCE_REQUIRED',
        message:
          'Refund and rollback require a reference; only WIN may also include one',
      });
    }
    const payloadHash = hashPayload({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: { amount: input.money.amount, currency: input.money.currency },
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
    const correlationId = context.correlationId ?? randomUUID();
    if (correlationId.length > 120) {
      throw new BadRequestException({
        code: 'INVALID_CORRELATION_ID',
        message: 'Correlation ID must not exceed 120 characters',
      });
    }
    const startedAt = performance.now();
    let failureCode: FailureCode | undefined;

    const maxDatabaseAttempts = this.configService.getOrThrow<number>(EnvironmentGlobalsEnum.MaxDatabaseAttempts);
    for (let attempt = 1; attempt <= maxDatabaseAttempts; attempt += 1) {
      try {
        const result = await this.transactionWithVerifiedRollback((manager) =>
          this.processSubmission(manager, input, money, idempotencyKey, payloadHash, correlationId, context.inbox, failureCode),
        );
        if (result) {
          this.metrics.increment(`transactions_${result.status.toLowerCase()}`);
          if (result.idempotentReplay) {
            this.metrics.increment('duplicates_detected');
          }
          this.metrics.recordProcessingLatency(performance.now() - startedAt);
          this.logger.log({
            event: 'wager_transaction_completed',
            correlationId,
            messageId: context.inbox?.messageId,
            transactionId: result.transactionId,
            walletId: input.walletId,
            providerId: input.providerId,
            status: result.status,
          });
        }
        return result;
      } catch (error) {
        if (!failureCode && error instanceof RolledBackPermissionDeniedError) {
          failureCode = FailureCode.InfrastructurePermissionDenied;
          this.logger.error({
            event: 'wager_transaction_database_permission_denied',
            correlationId,
            walletId: input.walletId,
            providerId: input.providerId,
          });
          attempt -= 1;
          continue;
        }
        if (isUniqueViolation(error)) {
          const existing = await this.wagerTransactionRepository.findOne(this.dataSource.manager, { where: { idempotencyKey } });
          if (existing) {
            if (existing.payloadHash !== payloadHash) {
              throw new IdempotencyConflictError();
            }
            if (context.inbox) {
              const replay = await this.dataSource.transaction((manager) =>
                this.processSubmission(
                  manager,
                  input,
                  money,
                  idempotencyKey,
                  payloadHash,
                  correlationId,
                  context.inbox,
                ),
              );
              if (replay) this.metrics.increment('duplicates_detected');
              return replay;
            }
            this.metrics.increment('duplicates_detected');
            return this.toResponse(existing, true);
          }
          const externalTransaction = await this.wagerTransactionRepository.findOne(
            this.dataSource.manager,
            {
              where: {
                providerId: input.providerId,
                externalTransactionId: input.externalTransactionId,
              },
            },
          );
          if (externalTransaction) {
            throw new ConflictException({
              code: 'EXTERNAL_TRANSACTION_ALREADY_EXISTS',
              message: 'The provider transaction ID was already used',
            });
          }
          throw error;
        }
        if (!isTransientDatabaseError(error)) {
          throw error;
        }
        this.metrics.increment('database_retries');
        if (isDatabaseLockConflict(error)) {
          this.metrics.recordLockConflict();
        }
        if (attempt === maxDatabaseAttempts) {
          this.logger.error({
            event: 'wager_transaction_database_retry_exhausted',
            correlationId,
            walletId: input.walletId,
            providerId: input.providerId,
          });
          throw serviceUnavailable(
            'The transaction could not be processed; retry later',
          );
        }
      }
    }
    throw serviceUnavailable(
      'The transaction could not be processed; retry later',
    );
  }

  async getTransaction(transactionId: string, providerId?: string): Promise<TransactionResponse> {
    const transaction = await this.wagerTransactionRepository.findOne(
      this.dataSource.manager,
      {
        where: providerId
          ? { id: transactionId, providerId }
          : { id: transactionId },
      },
    );
    if (!transaction) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Wager transaction not found',
      });
    }
    return this.toResponse(transaction, false);
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string): Promise<TransactionResponse> {
    const transaction = await this.wagerTransactionRepository.findOne(
      this.dataSource.manager,
      { where: { providerId, externalTransactionId } },
    );
    if (!transaction) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Provider transaction not found',
      });
    }
    return this.toResponse(transaction, false);
  }

  async reprocessPendingReferences(): Promise<void> {
    const due = await this.wagerTransactionRepository.find(this.dataSource.manager, {
      where: {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: LessThanOrEqual(new Date()),
      },
      order: { nextReferenceAttemptAt: 'ASC' },
      take: 100,
    });
    await Promise.all(
      due.map((transaction) => this.retryPendingReference(transaction.id)),
    );
  }

  private async processSubmission(manager: EntityManager, input: SubmitWagerInput, money: Money, idempotencyKey: string, payloadHash: string, correlationId: string, inbox?: SubmitContext['inbox'], failureCode?: FailureCode): Promise<TransactionResponse | null> {
    let inboxMessage: InboxMessage | undefined;
    if (inbox) {
      const newMessage = InboxMessage.receive({ ...inbox, receivedAt: new Date() });
      const received = await this.inboxRepository.receive(manager, newMessage);
      if (!received) {
        throw new Error('Inbox message could not be persisted');
      }
      inboxMessage = InboxMessage.rehydrate({
        consumerName: received.consumerName,
        messageId: received.messageId,
        payloadHash: received.payloadHash,
        receivedAt: received.receivedAt,
        processedAt: received.processedAt ?? undefined,
      });
      if (inboxMessage.payloadHash !== inbox.payloadHash) {
        throw new PermanentMessageError(
          'Inbox message ID was reused with a different payload',
        );
      }
      if (inboxMessage.isProcessed()) {
        const existing = await this.wagerTransactionRepository.findOne(manager, {
          where: { idempotencyKey },
        });
        if (
          existing?.status === WagerTransactionStatus.Failed &&
          existing.payloadHash === payloadHash
        ) {
          return this.toResponse(existing, true);
        }
        return null;
      }
    }

    const existing = await this.wagerTransactionRepository.findOne(manager, {
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdempotencyConflictError();
      }
      if (inboxMessage) {
        inboxMessage.markProcessed(new Date());
        await this.inboxRepository.markProcessed(manager, inboxMessage);
      }
      return this.toResponse(existing, true);
    }

    const now = new Date();
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });
    const entity = this.wagerTransactionRepository.create(manager, {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      moneyAmount: transaction.money.toString(),
      moneyCurrency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: null,
      status: transaction.status,
      failureCode: null,
      correlationId,
      createdAt: now,
      processedAt: null,
      resultBalanceAmount: null,
      resultBalanceCurrency: null,
      pendingReferenceAttempts: 0,
      nextReferenceAttemptAt: null,
    });
    await this.wagerTransactionRepository.insert(manager, entity);
    let response: TransactionResponse;
    if (failureCode) {
      transaction.fail(failureCode);
      entity.status = transaction.status;
      entity.failureCode = failureCode;
      entity.processedAt = now;
      await this.wagerTransactionRepository.save(manager, entity);
      await this.enqueueFailedEvent(manager, entity, failureCode, now);
      response = this.toResponse(entity, false);
    } else {
      response = await this.applyTransaction(manager, entity, transaction, correlationId, now);
    }
    if (inboxMessage) {
      inboxMessage.markProcessed(new Date());
      await this.inboxRepository.markProcessed(manager, inboxMessage);
    }
    return response;
  }

  private async applyTransaction(manager: EntityManager, entity: WagerTransactionEntity, transaction: WagerTransaction, correlationId: string, now: Date): Promise<TransactionResponse> {
    const walletEntity = await this.walletRepository.findById(manager, transaction.walletId, true);
    if (!walletEntity) {
      return this.reject(
        manager,
        entity,
        transaction,
        FailureCode.WalletNotFound,
        undefined,
        correlationId,
        now,
      );
    }
    const wallet = this.rehydrateWallet(walletEntity);
    if (wallet.playerId !== transaction.playerId) {
      return this.reject(
        manager,
        entity,
        transaction,
        FailureCode.PlayerMismatch,
        wallet,
        correlationId,
        now,
      );
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(
        manager,
        entity,
        transaction,
        FailureCode.CurrencyMismatch,
        wallet,
        correlationId,
        now,
      );
    }

    let reference: WagerTransactionEntity | undefined;
    let direction: LedgerDirection | undefined;
    if (transaction.referenceExternalTransactionId) {
      reference =
        (await this.wagerTransactionRepository.findOne(manager, {
          where: {
            providerId: transaction.providerId,
            externalTransactionId: transaction.referenceExternalTransactionId,
          },
          lock: { mode: 'pessimistic_write' },
        })) ?? undefined;
      if (!reference) {
        return this.deferForReference(
          manager,
          entity,
          transaction,
          wallet,
          correlationId,
          now,
        );
      }
      const referenceFailure = await this.validateReference(
        manager,
        transaction,
        reference,
        wallet,
      );
      if (referenceFailure) {
        return this.reject(
          manager,
          entity,
          transaction,
          referenceFailure,
          wallet,
          correlationId,
          now,
        );
      }
      if (transaction.kind === WagerTransactionKindEnum.Win) {
        direction = transaction.ledgerDirectionFor();
      } else {
        const priorReversal = await this.wagerTransactionRepository.findOne(manager, {
          where: {
            referenceTransactionId: reference.id,
            kind: In([
              WagerTransactionKindEnum.Refund,
              WagerTransactionKindEnum.Rollback,
            ]),
            status: WagerTransactionStatus.Processed,
          },
        });
        if (priorReversal) {
          return this.reject(
            manager,
            entity,
            transaction,
            FailureCode.AlreadyReversed,
            wallet,
            correlationId,
            now,
          );
        }

        const referenceLedger = await this.ledgerRepository.findByTransaction(
          manager,
          reference.id,
          wallet.id,
        );
        if (!referenceLedger) {
          return this.reject(
            manager,
            entity,
            transaction,
            FailureCode.ReferenceInvalid,
            wallet,
            correlationId,
            now,
          );
        }
        if (
          !Money.fromStored(
            reference.moneyAmount,
            reference.moneyCurrency,
          ).equals(transaction.money)
        ) {
          return this.reject(
            manager,
            entity,
            transaction,
            FailureCode.ReferenceAmountMismatch,
            wallet,
            correlationId,
            now,
          );
        }
        direction = transaction.ledgerDirectionFor(referenceLedger.direction);
      }
    } else {
      direction = transaction.ledgerDirectionFor();
    }

    if (
      direction === LedgerDirection.Debit &&
      wallet.balance.isLessThan(transaction.money)
    ) {
      const failureCode: FailureCode =
        transaction.kind === WagerTransactionKindEnum.Rollback
          ? FailureCode.RollbackNegativeBalance
          : FailureCode.InsufficientFunds;
      return this.reject(
        manager,
        entity,
        transaction,
        failureCode,
        wallet,
        correlationId,
        now,
      );
    }

    if (
      direction === LedgerDirection.Credit &&
      !wallet.balance.canAdd(transaction.money)
    ) {
      return this.reject(
        manager,
        entity,
        transaction,
        FailureCode.BalanceLimitExceeded,
        wallet,
        correlationId,
        now,
      );
    }

    let entry: WalletLedgerEntry | undefined;
    if (direction === LedgerDirection.Credit) {
      const movement = wallet.credit(transaction.money, now);
      entry = WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: transaction.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      });
    } else if (direction === LedgerDirection.Debit) {
      const movement = wallet.debit(transaction.money, now);
      entry = WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: transaction.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      });
    }

    transaction.markProcessed(reference?.id, now);
    entity.referenceTransactionId = reference?.id ?? null;
    entity.status = transaction.status;
    entity.processedAt = now;
    entity.failureCode = null;
    entity.resultBalanceAmount = wallet.balance.toString();
    entity.resultBalanceCurrency = wallet.currency;
    entity.nextReferenceAttemptAt = null;
    await this.wagerTransactionRepository.save(manager, entity);

    if (entry) {
      walletEntity.balance = wallet.balance.toString();
      walletEntity.version = wallet.version;
      walletEntity.updatedAt = wallet.updatedAt;
      await this.walletRepository.save(manager, walletEntity);
      await this.ledgerRepository.insert(manager, entry, wallet.version);
    }
    await this.enqueueEvent(
      manager,
      new WagerTransactionProcessed({
        aggregateId: wallet.id,
        correlationId,
        causationId: transaction.id,
        occurredAt: now,
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          walletId: wallet.id,
          kind: transaction.kind,
          status: WagerTransactionStatus.Processed,
        },
      }),
    );
    if (entry) {
      await this.enqueueEvent(
        manager,
        new WalletBalanceChanged({
          aggregateId: wallet.id,
          correlationId,
          causationId: transaction.id,
          occurredAt: now,
          data: {
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: entry.direction,
            money: transaction.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        }),
      );
    }
    return this.toResponse(entity, false);
  }

  private async validateReference(manager: EntityManager, transaction: WagerTransaction, reference: WagerTransactionEntity, wallet: Wallet): Promise<FailureCode | undefined> {
    if (
      reference.status !== WagerTransactionStatus.Processed ||
      reference.walletId !== wallet.id ||
      reference.playerId !== wallet.playerId ||
      reference.moneyCurrency !== wallet.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (
      transaction.kind === WagerTransactionKindEnum.Refund &&
      reference.kind !== WagerTransactionKindEnum.Bet
    ) {
      return FailureCode.ReferenceInvalid;
    }
    if (
      transaction.kind === WagerTransactionKindEnum.Win &&
      reference.kind !== WagerTransactionKindEnum.Bet
    ) {
      return FailureCode.ReferenceInvalid;
    }
    if (
      transaction.kind === WagerTransactionKindEnum.Rollback &&
      ![
        WagerTransactionKindEnum.Bet,
        WagerTransactionKindEnum.Win,
        WagerTransactionKindEnum.Refund,
      ].includes(reference.kind)
    ) {
      return FailureCode.ReferenceInvalid;
    }
    const existingEntry = await this.ledgerRepository.findByTransaction(
      manager,
      reference.id,
      wallet.id,
    );
    if (!existingEntry) {
      return FailureCode.ReferenceInvalid;
    }
    return undefined;
  }

  private async reject(
    manager: EntityManager,
    entity: WagerTransactionEntity,
    transaction: WagerTransaction,
    failureCode: FailureCode,
    wallet: Wallet | undefined,
    correlationId: string,
    now: Date,
  ): Promise<TransactionResponse> {
    transaction.reject(failureCode);
    entity.status = transaction.status;
    entity.failureCode = failureCode;
    entity.processedAt = now;
    entity.resultBalanceAmount = wallet?.balance.toString() ?? null;
    entity.resultBalanceCurrency = wallet?.currency ?? null;
    entity.nextReferenceAttemptAt = null;
    await this.wagerTransactionRepository.save(manager, entity);
    await this.enqueueEvent(
      manager,
      new WagerTransactionRejected({
        aggregateId: wallet?.id ?? transaction.id,
        correlationId,
        causationId: transaction.id,
        occurredAt: now,
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          walletId: transaction.walletId,
          kind: transaction.kind,
          failureCode,
        },
      }),
    );
    this.logger.warn({
      event: 'wager_transaction_rejected',
      correlationId,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      failureCode,
    });
    return this.toResponse(entity, false);
  }

  private async deferForReference(
    manager: EntityManager,
    entity: WagerTransactionEntity,
    transaction: WagerTransaction,
    wallet: Wallet,
    correlationId: string,
    now: Date,
  ): Promise<TransactionResponse> {
    const attempts = entity.pendingReferenceAttempts + 1;
    if (
      attempts >=
      this.configService.getOrThrow<number>(
        EnvironmentGlobalsEnum.MaxPendingReferenceAttempts,
      )
    ) {
      return this.reject(
        manager,
        entity,
        transaction,
        FailureCode.ReferenceNotFound,
        wallet,
        correlationId,
        now,
      );
    }
    transaction.markPendingReference();
    entity.status = transaction.status;
    entity.pendingReferenceAttempts = attempts;
    entity.nextReferenceAttemptAt = new Date(
      now.getTime() + Math.min(5_000 * 2 ** (attempts - 1), 3_600_000),
    );
    entity.resultBalanceAmount = wallet.balance.toString();
    entity.resultBalanceCurrency = wallet.currency;
    await this.wagerTransactionRepository.save(manager, entity);
    await this.enqueueEvent(
      manager,
      new WagerTransactionPendingReference({
        aggregateId: wallet.id,
        correlationId,
        causationId: transaction.id,
        occurredAt: now,
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          walletId: wallet.id,
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId!,
        },
      }),
    );
    return this.toResponse(entity, false);
  }

  private async retryPendingReference(transactionId: string): Promise<void> {
    try {
      await this.transactionWithVerifiedRollback(async (manager) => {
        const entity = await this.wagerTransactionRepository.findOne(manager, {
          where: {
            id: transactionId,
            status: WagerTransactionStatus.PendingReference,
            nextReferenceAttemptAt: LessThanOrEqual(new Date()),
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!entity) {
          return;
        }
        const money = Money.fromStored(
          entity.moneyAmount,
          entity.moneyCurrency,
        );
        const transaction = WagerTransaction.rehydrate({
          id: entity.id,
          providerId: entity.providerId,
          externalTransactionId: entity.externalTransactionId,
          idempotencyKey: entity.idempotencyKey,
          payloadHash: entity.payloadHash,
          walletId: entity.walletId,
          playerId: entity.playerId,
          roundId: entity.roundId,
          gameId: entity.gameId,
          kind: entity.kind,
          money,
          referenceExternalTransactionId:
            entity.referenceExternalTransactionId ?? undefined,
          createdAt: entity.createdAt,
          status: WagerTransactionStatus.Pending,
        });
        entity.status = WagerTransactionStatus.Pending;
        entity.nextReferenceAttemptAt = null;
        await this.wagerTransactionRepository.save(manager, entity);
        const result = await this.applyTransaction(
          manager,
          entity,
          transaction,
          entity.correlationId,
          new Date(),
        );
        this.metrics.increment(`transactions_${result.status.toLowerCase()}`);
      });
    } catch (error) {
      if (error instanceof RolledBackPermissionDeniedError) {
        try {
          await this.failPendingReference(transactionId);
        } catch (failureError) {
          this.logger.error({
            event: 'pending_reference_failure_recording_failed',
            transactionId,
            errorType:
              failureError instanceof Error
                ? failureError.name
                : 'UnknownError',
          });
        }
      }
      if (isTransientDatabaseError(error)) {
        this.metrics.increment('database_retries');
      }
      this.logger.error({
        event: 'pending_reference_retry_failed',
        transactionId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private async failPendingReference(transactionId: string): Promise<void> {
    const recorded = await this.dataSource.transaction(async (manager) => {
      const entity = await this.wagerTransactionRepository.findOne(manager, {
        where: {
          id: transactionId,
          status: WagerTransactionStatus.PendingReference,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entity) return false;
      entity.status = WagerTransactionStatus.Failed;
      entity.failureCode = FailureCode.InfrastructurePermissionDenied;
      entity.processedAt = new Date();
      entity.nextReferenceAttemptAt = null;
      await this.wagerTransactionRepository.save(manager, entity);
      await this.enqueueFailedEvent(
        manager,
        entity,
        FailureCode.InfrastructurePermissionDenied,
        entity.processedAt,
      );
      return true;
    });
    if (recorded) this.metrics.increment('transactions_failed');
  }

  private async enqueueFailedEvent(
    manager: EntityManager,
    entity: WagerTransactionEntity,
    failureCode: FailureCode,
    occurredAt: Date,
  ): Promise<void> {
    await this.enqueueEvent(
      manager,
      new WagerTransactionFailed({
        aggregateId: entity.walletId,
        correlationId: entity.correlationId,
        causationId: entity.id,
        occurredAt,
        data: {
          transactionId: entity.id,
          providerId: entity.providerId,
          walletId: entity.walletId,
          kind: entity.kind,
          failureCode,
        },
      }),
    );
  }

  private async enqueueEvent(manager: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    await this.outboxRepository.enqueue(manager, event);
  }

  private rehydrateWallet(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.fromStored(entity.balance, entity.currency),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  private toResponse(
    entity: WagerTransactionEntity,
    idempotentReplay: boolean,
  ): TransactionResponse {
    return {
      transactionId: entity.id,
      status: entity.status,
      ...(entity.resultBalanceAmount !== null && entity.resultBalanceCurrency
        ? {
          balance: Money.fromStored(
            entity.resultBalanceAmount,
            entity.resultBalanceCurrency,
          ).toJSON(),
        }
        : {}),
      ...(entity.failureCode ? { failureCode: entity.failureCode } : {}),
      idempotentReplay,
    };
  }

  private async transactionWithVerifiedRollback<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    let callbackError: unknown;
    let discardConnection = false;
    try {
      await runner.startTransaction();
      let result: T;
      try {
        result = await work(runner.manager);
      } catch (error) {
        callbackError = error;
        throw error;
      }
      await runner.commitTransaction();
      return result;
    } catch (error) {
      let rolledBack = false;
      if (runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
          rolledBack = true;
        } catch (rollbackError) {
          discardConnection = true;
          this.logger.error({
            event: 'wager_transaction_rollback_failed',
            errorType:
              rollbackError instanceof Error
                ? rollbackError.name
                : 'UnknownError',
          });
          throw new Error('Database transaction rollback failed', {
            cause: rollbackError,
          });
        }
      }
      if (
        rolledBack &&
        error === callbackError &&
        isDatabasePermissionDenied(error)
      ) {
        throw new RolledBackPermissionDeniedError(error);
      }
      throw error;
    } finally {
      if (discardConnection) {
        await this.closeFailedConnection(runner);
      }
      await runner.release();
    }
  }

  private async closeFailedConnection(runner: QueryRunner): Promise<void> {
    const connection: unknown = await runner.connect();
    if (
      !connection ||
      typeof connection !== 'object' ||
      !('end' in connection) ||
      typeof connection.end !== 'function'
    ) {
      throw new Error(
        'Cannot close database connection after rollback failure',
      );
    }
    await connection.end();
  }
}
