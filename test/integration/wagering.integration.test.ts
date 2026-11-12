import { createHash, randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { configuration } from '../../config/env/configuration.js';
import { DataSource } from 'typeorm';
import {
  IdempotencyConflictError,
  PermanentMessageError,
} from '../../src/shared/errors/domain-errors.js';
import { getDataSourceOptions } from '../../src/database/data-source-options.js';
import { WalletLedgerEntryEntity } from '../../src/database/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/database/entities/wager-transaction.entity.js';
import { MetricsService } from '../../src/shared/observability/metrics.service.js';
import { StructuredLogger } from '../../src/shared/observability/structured-logger.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import { SqsService } from '../../src/modules/messaging/services/sqs.service.js';
import { OutboxPublisher } from '../../src/modules/messaging/publishers/outbox.publisher.js';
import { WagerTransactionKindEnum } from '../../src/modules/wagering/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/enums/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/modules/wagering/enums/failure-code.enum.js';
import { LedgerDirection } from '../../src/modules/wallets/enums/ledger-direction.enum.js';
import { expectAllWalletsReconciled } from '../fixtures/reconciliation.js';
import { createWageringRepositories, createWalletService } from '../fixtures/wagering-repositories.js';
import { WalletService } from '../../src/modules/wallets/services/wallet.service.js';
import { WalletRepository } from '../../src/modules/wallets/repositories/wallet.repository.js';
import { InboxRepository } from '../../src/modules/messaging/repositories/inbox.repository.js';
import { OutboxRepository } from '../../src/modules/messaging/repositories/outbox.repository.js';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message.js';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/integration-events.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;
const sqsEndpoint = process.env.TEST_SQS_ENDPOINT ?? process.env.SQS_ENDPOINT;
if (sqsEndpoint) {
  process.env.SQS_ENDPOINT = sqsEndpoint;
  process.env.SQS_TRANSACTION_QUEUE_URL ??= `${sqsEndpoint}/000000000000/wager-transactions.fifo`;
  process.env.SQS_EVENT_QUEUE_URL ??= `${sqsEndpoint}/000000000000/wager-events.fifo`;
}
const sqsSuite = databaseUrl && sqsEndpoint ? describe : describe.skip;

async function expectToReject(promise: Promise<unknown>): Promise<void> {
  const result = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
}

databaseSuite('PostgreSQL wagering integration', () => {
  const sources: DataSource[] = [];
  const services: WageringService[] = [];
  const walletServices: WalletService[] = [];

  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) {
      const source = new DataSource({
        ...getDataSourceOptions(),
        url: databaseUrl,
        migrationsRun: false,
        poolSize: 20,
      });
      await source.initialize();
      sources.push(source);
    }
    await sources[0].runMigrations();
    for (const source of sources) {
      walletServices.push(createWalletService(source));
      services.push(
        new WageringService(
          source,
          new MetricsService(),
          new StructuredLogger(),
          new ConfigService(configuration({ NODE_ENV: 'test' })),
          ...createWageringRepositories(),
        ),
      );
    }
  });

  afterAll(async () => {
    await Promise.all(sources.map((source) => source.destroy()));
  });

  afterEach(async () => {
    if (!sources[0]?.isInitialized) return;
    await expectAllWalletsReconciled(sources[0]);
  });

  it('rolls back wallet creation when an opening event cannot be saved', async () => {
    const playerId = randomUUID();
    const sentinel = new Error('injected outbox failure');
    let walletId: string | undefined;
    let count = 0;
    const [wallet, ledger, transactions, , outbox] = createWageringRepositories();
    const walletService = new WalletService(
      sources[0],
      new MetricsService(),
      new StructuredLogger(),
      wallet,
      ledger,
      transactions,
      outbox,
    );
    const original = outbox.enqueue.bind(outbox);
    const spy = spyOn(outbox, 'enqueue').mockImplementation(
      async (manager, event) => {
        walletId = event.aggregateId;
        count += 1;
        if (count === 2) throw sentinel;
        return original(manager, event);
      },
    );
    try {
      const error = await walletService
        .createWallet({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        })
        .then(() => undefined, (reason: unknown) => reason);
      expect(error).toBe(sentinel);
      expect(count).toBe(2);
      expect(walletId).toBeDefined();
      const [row] = (await sources[0].query(
        `SELECT
          (SELECT count(*)::int FROM wallets WHERE id = $1) AS wallets,
          (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = $1) AS transactions,
          (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = $1) AS ledger,
          (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = $1) AS outbox`,
        [walletId],
      )) as Array<{ wallets: number; transactions: number; ledger: number; outbox: number }>;
      expect(row).toEqual({ wallets: 0, transactions: 0, ledger: 0, outbox: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it('rolls back changes across repositories using the same transaction manager', async () => {
    const wallets = new WalletRepository();
    const inbox = new InboxRepository();
    const outbox = new OutboxRepository();
    const walletId = randomUUID();
    const messageId = randomUUID();
    const event = new WagerTransactionProcessed({
      aggregateId: walletId,
      correlationId: randomUUID(),
      data: {
        transactionId: randomUUID(),
        providerId: 'repository-rollback',
        walletId,
        kind: WagerTransactionKindEnum.Bet,
        status: WagerTransactionStatus.Processed,
      },
    });
    const sentinel = new Error('force repository rollback');
    let caught: unknown;
    try {
      await sources[0].transaction(async (manager) => {
        const now = new Date();
        await wallets.insert(manager, {
          id: walletId,
          playerId: randomUUID(),
          currency: 'BRL',
          balance: '0.00',
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        await inbox.receive(
          manager,
          InboxMessage.receive({
            consumerName: 'repository-test',
            messageId,
            payloadHash: 'a'.repeat(64),
            receivedAt: now,
          }),
        );
        await outbox.enqueue(manager, event);
        expect(await wallets.findById(manager, walletId)).not.toBeNull();
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(await wallets.findById(sources[0].manager, walletId)).toBeNull();
    const [row] = (await sources[0].query(
      `SELECT
        (SELECT count(*)::int FROM inbox_messages WHERE message_id = $1) AS inbox_count,
        (SELECT count(*)::int FROM outbox_messages WHERE id = $2) AS outbox_count`,
      [messageId, event.eventId],
    )) as Array<{ inbox_count: number; outbox_count: number }>;
    expect(row.inbox_count).toBe(0);
    expect(row.outbox_count).toBe(0);
  });

  async function injectLedgerPermissionFailure(
    walletId: string,
    deferred = false,
  ): Promise<() => Promise<void>> {
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_permission_${suffix}`;
    const triggerName = `test_permission_trigger_${suffix}`;
    await sources[0].query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RAISE EXCEPTION 'injected permission failure' USING ERRCODE = '42501'; END; $$`,
    );
    try {
      await sources[0].query(
        `CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER ${triggerName}
         ${deferred ? 'AFTER' : 'BEFORE'} INSERT ON wallet_ledger_entries
         ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''}
         FOR EACH ROW WHEN (NEW.wallet_id = '${walletId}'::uuid)
         EXECUTE FUNCTION ${functionName}()`,
      );
    } catch (error) {
      await sources[0].query(`DROP FUNCTION ${functionName}()`);
      throw error;
    }
    return async () => {
      await sources[0].query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON wallet_ledger_entries`,
      );
      await sources[0].query(`DROP FUNCTION ${functionName}()`);
    };
  }

  it('records a real rolled-back permission failure once under concurrent submissions', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'permission-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'permission-test',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const cleanup = await injectLedgerPermissionFailure(wallet.id);
    try {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          services[index % services.length].submit(input, key),
        ),
      );
      const first = responses[0];
      if (!first) throw new Error('Missing transaction response');
      expect(
        new Set(responses.map((result) => result?.transactionId)).size,
      ).toBe(1);
      expect(
        responses.every(
          (result) => result?.status === WagerTransactionStatus.Failed,
        ),
      ).toBe(true);
      expect(first.failureCode).toBe(
        FailureCode.InfrastructurePermissionDenied,
      );
      expect(
        responses.filter((result) => !result?.idempotentReplay),
      ).toHaveLength(1);
      const [row] = (await sources[0].query(
        `SELECT processed_at, count(*) OVER ()::int AS count
         FROM wager_transactions WHERE idempotency_key = $1`,
        [key],
      )) as Array<{ processed_at: Date | null; count: number }>;
      expect(row.count).toBe(1);
      expect(row.processed_at).not.toBeNull();
      const [event] = (await sources[0].query(
        `SELECT count(*)::int AS count FROM outbox_messages
         WHERE event_type = 'WagerTransactionFailed' AND payload->'data'->>'transactionId' = $1`,
        [first.transactionId],
      )) as Array<{ count: number }>;
      expect(event.count).toBe(1);
      expect(await services[1].submit(input, key)).toEqual({
        ...first,
        idempotentReplay: true,
      });
      const conflict = await services[1]
        .submit({ ...input, money: { amount: '11.00', currency: 'BRL' } }, key)
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(IdempotencyConflictError);
      expect(
        await sources[0].getRepository(WalletLedgerEntryEntity).count({
          where: { transactionId: first.transactionId },
        }),
      ).toBe(0);
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
    } finally {
      await cleanup();
    }
  });

  it('does not classify a permission error raised at commit as FAILED', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'commit-failure-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'commit-failure-test',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const cleanup = await injectLedgerPermissionFailure(wallet.id, true);
    try {
      await expectToReject(services[0].submit(input, key));
      expect(
        await sources[0].getRepository(WagerTransactionEntity).count({
          where: { idempotencyKey: key },
        }),
      ).toBe(0);
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
    } finally {
      await cleanup();
    }
    expect((await services[0].submit(input, key))?.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '90.00',
    );
  });

  it('preserves a concurrent successful result before recording a rolled-back failure', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'failure-race-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'failure-race-test',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const cleanup = await injectLedgerPermissionFailure(wallet.id);
    let rollbackObserved!: () => void;
    let resumeRollback!: () => void;
    const rolledBack = new Promise<void>((resolve) => {
      rollbackObserved = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeRollback = resolve;
    });
    const createRunner = sources[0].createQueryRunner.bind(sources[0]);
    const runnerSpy = spyOn(sources[0], 'createQueryRunner').mockImplementation(
      (mode) => {
        const runner = createRunner(mode);
        const originalRollback = runner.rollbackTransaction.bind(runner);
        runner.rollbackTransaction = async () => {
          await originalRollback();
          rollbackObserved();
          await resume;
        };
        return runner;
      },
    );
    const failedAttempt = services[0].submit(input, key);
    let cleaned = false;
    try {
      await rolledBack;
      await cleanup();
      cleaned = true;
      const winner = await services[1].submit(input, key);
      if (!winner) throw new Error('Missing winning transaction');
      expect(winner.status).toBe(WagerTransactionStatus.Processed);
      resumeRollback();
      const replay = await failedAttempt;
      expect(replay).toEqual({ ...winner, idempotentReplay: true });
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '90.00',
      );
      expect(
        await sources[0].getRepository(WalletLedgerEntryEntity).count({
          where: { transactionId: winner.transactionId },
        }),
      ).toBe(1);
    } finally {
      resumeRollback();
      runnerSpy.mockRestore();
      if (!cleaned) await cleanup();
      await failedAttempt.catch(() => undefined);
    }
  });

  it('does not record FAILED or reuse a connection when rollback cannot be confirmed', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'rollback-failure-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'rollback-failure-test',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const cleanup = await injectLedgerPermissionFailure(wallet.id);
    const createRunner = sources[0].createQueryRunner.bind(sources[0]);
    const runnerSpy = spyOn(sources[0], 'createQueryRunner').mockImplementation(
      (mode) => {
        const runner = createRunner(mode);
        runner.rollbackTransaction = async () => {
          throw new Error('Injected rollback failure');
        };
        return runner;
      },
    );
    try {
      const error = await services[0]
        .submit(input, key)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('rollback failed');
    } finally {
      runnerSpy.mockRestore();
      await cleanup();
    }
    expect(
      await sources[0].getRepository(WagerTransactionEntity).count({
        where: { idempotencyKey: key },
      }),
    ).toBe(0);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '100.00',
    );
    expect((await services[0].submit(input, key))?.status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  it('does not persist FAILED when its outbox event cannot be persisted', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'failure-record-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'failure-record-test',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const cleanup = await injectLedgerPermissionFailure(wallet.id);
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_failure_record_${suffix}`;
    const triggerName = `test_failure_record_trigger_${suffix}`;
    await sources[0].query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RAISE EXCEPTION 'injected failure record error' USING ERRCODE = '42501'; END; $$`,
    );
    try {
      await sources[0].query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
         FOR EACH ROW WHEN (NEW.aggregate_id = '${wallet.id}'::uuid AND NEW.event_type = 'WagerTransactionFailed')
         EXECUTE FUNCTION ${functionName}()`,
      );
      await expectToReject(services[0].submit(input, key));
      expect(
        await sources[0].getRepository(WagerTransactionEntity).count({
          where: { idempotencyKey: key },
        }),
      ).toBe(0);
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
    } finally {
      await sources[0].query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON outbox_messages`,
      );
      await sources[0].query(`DROP FUNCTION ${functionName}()`);
      await cleanup();
    }
    expect((await services[0].submit(input, key))?.status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  it('records a real permission failure when reprocessing a pending reference', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const betId = randomUUID();
    const input = {
      providerId: 'pending-permission-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'pending-permission-test',
      kind: WagerTransactionKindEnum.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: betId,
    } as const;
    const key = randomUUID();
    const pending = await services[0].submit(input, key);
    if (!pending) throw new Error('Missing pending response');
    await services[0].submit(
      {
        ...input,
        kind: WagerTransactionKindEnum.Bet,
        externalTransactionId: betId,
        referenceExternalTransactionId: undefined,
      },
      randomUUID(),
    );
    await sources[0].query(
      'UPDATE wager_transactions SET next_reference_attempt_at = now() WHERE id = $1',
      [pending.transactionId],
    );
    const cleanup = await injectLedgerPermissionFailure(wallet.id);
    try {
      await services[0].reprocessPendingReferences();
      const failed = await services[0].getTransaction(pending.transactionId);
      expect(failed.status).toBe(WagerTransactionStatus.Failed);
      expect(failed.failureCode).toBe(
        FailureCode.InfrastructurePermissionDenied,
      );
      const [event] = (await sources[0].query(
        `SELECT count(*)::int AS count FROM outbox_messages
         WHERE event_type = 'WagerTransactionFailed' AND payload->'data'->>'transactionId' = $1`,
        [pending.transactionId],
      )) as Array<{ count: number }>;
      expect(event.count).toBe(1);
      expect(await services[1].submit(input, key)).toEqual({
        ...failed,
        idempotentReplay: true,
      });
      expect(
        await sources[0].getRepository(WalletLedgerEntryEntity).count({
          where: { transactionId: pending.transactionId },
        }),
      ).toBe(0);
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '90.00',
      );
    } finally {
      await cleanup();
    }
  });

  it('processes the same idempotency key 50 times across three database clients once', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = randomUUID();
    const idempotencyKey = `integration:${randomUUID()}`;
    const input = {
      providerId: 'integration-provider',
      externalTransactionId,
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'integration-game',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    } as const;

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        services[index % services.length].submit(input, idempotencyKey),
      ),
    );
    const transactions = new Set(
      responses.map((response) => response?.transactionId),
    );
    const debits = await sources[0]
      .getRepository(WalletLedgerEntryEntity)
      .count({
        where: { walletId: wallet.id, direction: LedgerDirection.Debit },
      });

    expect(transactions.size).toBe(1);
    expect(debits).toBe(1);
    expect(
      responses.filter((response) => response?.idempotentReplay),
    ).toHaveLength(49);
    expect((await walletServices[2].getWallet(wallet.id)).balance.amount).toBe(
      '75.00',
    );
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
    const conflictingPayload = services[0].submit(
      { ...input, money: { amount: '26.00', currency: 'BRL' } },
      idempotencyKey,
    );
    const conflict = await conflictingPayload.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
  });

  it('records every concurrent inbox message before acknowledging an idempotent replay', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'inbox-race-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'integration-game',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const consumerName = `race-${randomUUID()}`;
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await Promise.all(
      ids.map((messageId, index) =>
        services[index % services.length].submit(input, key, {
          inbox: { consumerName, messageId, payloadHash: 'a'.repeat(64) },
        }),
      ),
    );
    const rows = (await sources[0].query(
      'SELECT message_id, processed_at FROM inbox_messages WHERE consumer_name = $1',
      [consumerName],
    )) as Array<{ message_id: string; processed_at: Date | null }>;
    expect(rows).toHaveLength(ids.length);
    expect(rows.every((row) => row.processed_at !== null)).toBe(true);
    const conflict = await services[0]
      .submit({ ...input, externalTransactionId: randomUUID() }, randomUUID(), {
        inbox: {
          consumerName,
          messageId: ids[1],
          payloadHash: 'b'.repeat(64),
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(conflict).toBeInstanceOf(PermanentMessageError);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '90.00',
    );
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('reconciles from a single snapshot if a wager commits just before the query', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const originalQuery = sources[0].manager.query.bind(sources[0].manager);
    let injected = false;
    const spy = spyOn(sources[0].manager, 'query').mockImplementation(
      async (sql, params) => {
        if (!injected && typeof sql === 'string' && sql.includes('SUM(CASE')) {
          injected = true;
          await services[1].submit(
            {
              providerId: 'reconciliation-provider',
              externalTransactionId: randomUUID(),
              playerId,
              walletId: wallet.id,
              roundId: randomUUID(),
              gameId: 'integration-game',
              kind: WagerTransactionKindEnum.Bet,
              money: { amount: '10.00', currency: 'BRL' },
            },
            randomUUID(),
          );
        }
        return originalQuery(sql, params);
      },
    );
    try {
      const result = await walletServices[0].reconcile(wallet.id);
      expect(injected).toBe(true);
      expect(result.consistent).toBe(true);
      expect(result.storedBalance.amount).toBe('90.00');
      expect(result.calculatedBalance.amount).toBe('90.00');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects NaN monetary values at the database boundary', async () => {
    const playerId = randomUUID();
    await expectToReject(
      sources[0].query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES ($1, $2, 'BRL', 'NaN'::numeric, 1, now(), now())`,
        [randomUUID(), playerId],
      ),
    );
    await expectToReject(
      sources[0].query(
        `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
             status, correlation_id, created_at)
           VALUES ($1, 'nan-test', $2, $3, $4, $5, $6, 'round', 'game',
             'BET', 'NaN'::numeric, 'BRL', 'PENDING', $7, now())`,
        [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          randomUUID(),
          playerId,
          randomUUID(),
        ],
      ),
    );
  });

  it('supports an optional WIN reference and validates it without reversing the bet', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const common = {
      providerId: 'win-reference-provider',
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'integration-game',
      money: { amount: '10.00', currency: 'BRL' },
    } as const;
    const betId = randomUUID();
    const pending = await services[0].submit(
      {
        ...common,
        kind: WagerTransactionKindEnum.Win,
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: betId,
        money: { amount: '25.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(pending?.status).toBe(WagerTransactionStatus.PendingReference);
    await services[0].submit(
      {
        ...common,
        kind: WagerTransactionKindEnum.Bet,
        externalTransactionId: betId,
      },
      randomUUID(),
    );
    await sources[0].query(
      'UPDATE wager_transactions SET next_reference_attempt_at = now() WHERE id = $1',
      [pending!.transactionId],
    );
    await services[0].reprocessPendingReferences();
    expect(
      (await services[0].getTransaction(pending!.transactionId)).status,
    ).toBe(WagerTransactionStatus.Processed);
    const invalid = await services[0].submit(
      {
        ...common,
        roundId: randomUUID(),
        kind: WagerTransactionKindEnum.Win,
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: betId,
      },
      randomUUID(),
    );
    expect(invalid?.status).toBe(WagerTransactionStatus.Rejected);
    expect(invalid?.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '115.00',
    );
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('uses the configured pending reference attempt limit', async () => {
    const service = new WageringService(
      sources[0],
      new MetricsService(),
      new StructuredLogger(),
      new ConfigService(
        configuration({
          NODE_ENV: 'test',
          MAX_PENDING_REFERENCE_ATTEMPTS: '2',
        }),
      ),
      ...createWageringRepositories(),
    );
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const pending = await service.submit(
      {
        providerId: 'configured-attempts',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'configured-attempts',
        kind: WagerTransactionKindEnum.Refund,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: randomUUID(),
      },
      randomUUID(),
    );
    if (!pending) throw new Error('Missing pending transaction');
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await sources[0].query(
      'UPDATE wager_transactions SET next_reference_attempt_at = now() WHERE id = $1',
      [pending.transactionId],
    );
    await service.reprocessPendingReferences();
    const result = await service.getTransaction(pending.transactionId);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe('100.00');
  });

  it('uses the configured database retry limit for transient errors', async () => {
    const service = new WageringService(
      sources[0],
      new MetricsService(),
      new StructuredLogger(),
      new ConfigService(
        configuration({
          NODE_ENV: 'test',
          MAX_DATABASE_ATTEMPTS: '2',
        }),
      ),
      ...createWageringRepositories(),
    );
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const original = sources[0].createQueryRunner.bind(sources[0]);
    let attempts = 0;
    const spy = spyOn(sources[0], 'createQueryRunner').mockImplementation(
      (mode) => {
        const runner = original(mode);
        runner.startTransaction = async () => {
          attempts += 1;
          throw Object.assign(
            new Error('Injected transient database failure'),
            { code: '40001' },
          );
        };
        return runner;
      },
    );
    try {
      await expectToReject(
        service.submit(
          {
            providerId: 'configured-database-attempts',
            externalTransactionId: randomUUID(),
            playerId,
            walletId: wallet.id,
            roundId: randomUUID(),
            gameId: 'configured-attempts',
            kind: WagerTransactionKindEnum.Bet,
            money: { amount: '10.00', currency: 'BRL' },
          },
          randomUUID(),
        ),
      );
      expect(attempts).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe('100.00');
  });

  it('rejects a pending reference after the retry limit and records the rejection event', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const pending = await services[0].submit(
      {
        providerId: 'exhaustion-provider',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'integration-game',
        kind: WagerTransactionKindEnum.Refund,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: randomUUID(),
      },
      randomUUID(),
    );
    expect(pending?.status).toBe(WagerTransactionStatus.PendingReference);
    await sources[0].query(
      `UPDATE wager_transactions
       SET pending_reference_attempts = 7, next_reference_attempt_at = now()
       WHERE id = $1`,
      [pending!.transactionId],
    );
    await services[0].reprocessPendingReferences();
    const terminal = await services[0].getTransaction(pending!.transactionId);
    expect(terminal.status).toBe(WagerTransactionStatus.Rejected);
    expect(terminal.failureCode).toBe(FailureCode.ReferenceNotFound);
    const [row] = (await sources[0].query(
      `SELECT count(*)::int AS count FROM outbox_messages
       WHERE event_type = 'WagerTransactionRejected'
       AND payload->'data'->>'transactionId' = $1`,
      [pending!.transactionId],
    )) as Array<{ count: number }>;
    expect(row.count).toBe(1);
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('preserves a simulated failed record as terminal and replays it without moving funds', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'failed-state-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'failed-state-test',
      kind: WagerTransactionKindEnum.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: randomUUID(),
    } as const;
    const key = randomUUID();
    const pending = await services[0].submit(input, key);
    if (!pending) throw new Error('Submission returned no result');
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await expectToReject(
      sources[0].query(
        `UPDATE wager_transactions
         SET status = 'FAILED', next_reference_attempt_at = NULL
         WHERE id = $1`,
        [pending.transactionId],
      ),
    );
    expect(
      (await services[0].getTransaction(pending.transactionId)).status,
    ).toBe(WagerTransactionStatus.PendingReference);
    await sources[0].query(
      `UPDATE wager_transactions
       SET status = 'FAILED', failure_code = $2, processed_at = now(),
           next_reference_attempt_at = NULL
       WHERE id = $1 AND status = 'PENDING_REFERENCE'`,
      [pending.transactionId, FailureCode.InvalidTransaction],
    );
    const failed = await services[0].getTransaction(pending.transactionId);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.failureCode).toBe(FailureCode.InvalidTransaction);
    const replay = await services[1].submit(input, key);
    expect(replay).toEqual({ ...failed, idempotentReplay: true });
    await expectToReject(
      sources[0].query(
        `UPDATE wager_transactions SET status = 'PENDING', failure_code = NULL,
         processed_at = NULL WHERE id = $1`,
        [pending.transactionId],
      ),
    );
    expect(
      await sources[0].getRepository(WalletLedgerEntryEntity).count({
        where: { transactionId: pending.transactionId },
      }),
    ).toBe(0);
    const reconciliation = await walletServices[0].reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('100.00');
    expect(reconciliation.checkedEntries).toBe(1);
  });

  it('serializes competing bets and rejects the one that would overdraw the wallet', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[1].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const common = {
      providerId: 'integration-provider',
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'integration-game',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    } as const;

    const results = await Promise.all([
      services[0].submit(
        { ...common, externalTransactionId: randomUUID() },
        `integration:${randomUUID()}`,
      ),
      services[2].submit(
        { ...common, externalTransactionId: randomUUID() },
        `integration:${randomUUID()}`,
      ),
    ]);
    const statuses = results
      .map((result) => result?.status)
      .sort((left, right) => left!.localeCompare(right!));
    const debitCount = await sources[0]
      .getRepository(WalletLedgerEntryEntity)
      .count({
        where: { walletId: wallet.id, direction: LedgerDirection.Debit },
      });

    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(debitCount).toBe(1);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '20.00',
    );
    expect((await walletServices[2].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('returns the original balance on replay after a later movement', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      providerId: 'replay-snapshot-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'replay-snapshot',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    } as const;
    const key = randomUUID();
    const first = await services[0].submit(input, key);
    if (!first) throw new Error('HTTP-style submission returned no result');
    expect(first?.status).toBe(WagerTransactionStatus.Processed);
    expect(first?.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    const second = await services[1].submit(
      {
        ...input,
        externalTransactionId: randomUUID(),
        money: { amount: '10.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(second?.balance?.amount).toBe('65.00');
    const replay = await services[2].submit(input, key);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '65.00',
    );
    expect(
      await sources[0]
        .getRepository(WalletLedgerEntryEntity)
        .count({ where: { walletId: wallet.id } }),
    ).toBe(3);
    const reconciliation = await walletServices[0].reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(3);
    expect(reconciliation.difference.amount).toBe('0.00');
  });

  it('rejects a rollback that would overdraw the wallet without a ledger entry', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const winId = randomUUID();
    const common = {
      providerId: 'rollback-balance-provider',
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'rollback-balance',
      money: { amount: '50.00', currency: 'BRL' },
    } as const;
    const win = await services[0].submit(
      {
        ...common,
        externalTransactionId: winId,
        kind: WagerTransactionKindEnum.Win,
      },
      randomUUID(),
    );
    const bet = await services[1].submit(
      {
        ...common,
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Bet,
        money: { amount: '40.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(win?.balance?.amount).toBe('50.00');
    expect(bet?.balance?.amount).toBe('10.00');
    const before = await walletServices[0].getWallet(wallet.id);
    const rollback = await services[2].submit(
      {
        ...common,
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Rollback,
        referenceExternalTransactionId: winId,
      },
      randomUUID(),
    );
    expect(rollback?.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback?.failureCode).toBe(FailureCode.RollbackNegativeBalance);
    expect(rollback?.balance?.amount).toBe('10.00');
    expect(await walletServices[0].getWallet(wallet.id)).toEqual(before);
    expect(
      await sources[0].getRepository(WalletLedgerEntryEntity).count({
        where: { transactionId: rollback!.transactionId },
      }),
    ).toBe(0);
    const reconciliation = await walletServices[0].reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(2);
    expect(reconciliation.storedBalance.amount).toBe('10.00');
  });

  it('paginates the ledger without gaps or duplicates and rejects invalid cursors', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    for (let index = 0; index < 6; index += 1) {
      const result = await services[index % services.length].submit(
        {
          providerId: 'pagination-provider',
          externalTransactionId: randomUUID(),
          playerId,
          walletId: wallet.id,
          roundId: randomUUID(),
          gameId: 'pagination',
          kind: WagerTransactionKindEnum.Bet,
          money: { amount: '1.00', currency: 'BRL' },
        },
        randomUUID(),
      );
      expect(result?.status).toBe(WagerTransactionStatus.Processed);
    }
    const expected = await sources[0]
      .getRepository(WalletLedgerEntryEntity)
      .find({
        where: { walletId: wallet.id },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await walletServices[0].getLedger(wallet.id, cursor, 2);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(2);
      pages.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      expect(pages.length).toBeLessThanOrEqual(expected.length);
    } while (cursor);
    expect(expected).toHaveLength(7);
    expect(pages.map((entry) => entry.id)).toEqual(
      expected.map((entry) => entry.id),
    );
    expect(new Set(pages.map((entry) => entry.id)).size).toBe(expected.length);
    await expectToReject(walletServices[0].getLedger(wallet.id, 'not-a-cursor', 2));
    await expectToReject(walletServices[0].getLedger(wallet.id, undefined, 0));
    await expectToReject(walletServices[0].getLedger(wallet.id, undefined, 101));
    const reconciliation = await walletServices[0].reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(7);
    expect(reconciliation.storedBalance.amount).toBe('94.00');
  });

  it('prevents mixed reversals in either order and concurrently, while allowing a refund itself to be rolled back', async () => {
    for (const scenario of ['refund-first', 'rollback-first', 'concurrent']) {
      const playerId = randomUUID();
      const wallet = await walletServices[0].createWallet({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const betId = randomUUID();
      const refundId = randomUUID();
      const common = {
        providerId: 'mixed-reversal-provider',
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'reversal-test',
        money: { amount: '50.00', currency: 'BRL' },
      };
      await services[0].submit(
        {
          ...common,
          externalTransactionId: betId,
          kind: WagerTransactionKindEnum.Bet,
        },
        randomUUID(),
      );
      const refund = () =>
        services[0].submit(
          {
            ...common,
            externalTransactionId: refundId,
            kind: WagerTransactionKindEnum.Refund,
            referenceExternalTransactionId: betId,
          },
          randomUUID(),
        );
      const rollback = () =>
        services[1].submit(
          {
            ...common,
            externalTransactionId: randomUUID(),
            kind: WagerTransactionKindEnum.Rollback,
            referenceExternalTransactionId: betId,
          },
          randomUUID(),
        );
      let results;
      if (scenario === 'concurrent') {
        results = await Promise.all([refund(), rollback()]);
      } else if (scenario === 'refund-first') {
        results = [await refund(), await rollback()];
      } else {
        results = [await rollback(), await refund()];
      }
      expect(
        results.filter(
          (result) => result?.status === WagerTransactionStatus.Processed,
        ),
      ).toHaveLength(1);
      expect(
        results.filter(
          (result) => result?.failureCode === FailureCode.AlreadyReversed,
        ),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result?.failureCode === FailureCode.AlreadyReversed,
      );
      const processed = results.find(
        (result) => result?.status === WagerTransactionStatus.Processed,
      );
      const databaseError = await sources[0]
        .query(
          `UPDATE wager_transactions
             SET status = 'PROCESSED',
                 reference_transaction_id = (SELECT reference_transaction_id FROM wager_transactions WHERE id = $1)
             WHERE id = $2`,
          [processed!.transactionId, rejected!.transactionId],
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(databaseError).toBeInstanceOf(Error);
      expect((databaseError as Error).message).toContain(
        'referenced transaction already reversed',
      );
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
      expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);

      if (scenario === 'refund-first') {
        const undoRefund = await services[0].submit(
          {
            ...common,
            externalTransactionId: randomUUID(),
            kind: WagerTransactionKindEnum.Rollback,
            referenceExternalTransactionId: refundId,
          },
          randomUUID(),
        );
        expect(undoRefund?.status).toBe(WagerTransactionStatus.Processed);
        expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
          '50.00',
        );
        expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
      }
    }
  });

  it('rejects a credit above PostgreSQL numeric precision without changing balance', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '999999999999999999.99', currency: 'BRL' },
    });
    const result = await services[0].submit(
      {
        providerId: 'precision-provider',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'precision-test',
        kind: WagerTransactionKindEnum.Win,
        money: { amount: '0.01', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(result?.status).toBe(WagerTransactionStatus.Rejected);
    expect(result?.failureCode).toBe(FailureCode.BalanceLimitExceeded);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '999999999999999999.99',
    );
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
  });
  it('applies wins, losses, refunds and rollbacks without duplicate reversals', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const common = {
      providerId: 'rules-provider',
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'rules-game',
      money: { amount: '20.00', currency: 'BRL' },
    };
    const betId = randomUUID();
    const bet = await services[0].submit(
      {
        ...common,
        externalTransactionId: betId,
        kind: WagerTransactionKindEnum.Bet,
      },
      randomUUID(),
    );
    const loss = await services[0].submit(
      {
        ...common,
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Loss,
      },
      randomUUID(),
    );
    const winId = randomUUID();
    const win = await services[0].submit(
      {
        ...common,
        externalTransactionId: winId,
        kind: WagerTransactionKindEnum.Win,
      },
      randomUUID(),
    );
    const refund = await services[0].submit(
      {
        ...common,
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Refund,
        referenceExternalTransactionId: betId,
      },
      randomUUID(),
    );
    const duplicateRefund = await services[0].submit(
      {
        ...common,
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Refund,
        referenceExternalTransactionId: betId,
      },
      randomUUID(),
    );
    const rollback = await services[0].submit(
      {
        ...common,
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Rollback,
        referenceExternalTransactionId: winId,
      },
      randomUUID(),
    );
    expect([
      bet?.status,
      loss?.status,
      win?.status,
      refund?.status,
      rollback?.status,
    ]).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
    ]);
    expect(duplicateRefund?.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicateRefund?.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
      '100.00',
    );
    expect(
      await sources[0]
        .getRepository(WalletLedgerEntryEntity)
        .count({ where: { walletId: wallet.id } }),
    ).toBe(5);
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('uses one player wallet across providers while keeping references provider-specific', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const roundId = randomUUID();
    const betId = randomUUID();
    const base = {
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'shared-wallet',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const bet = await services[0].submit(
      {
        ...base,
        providerId: 'shared-provider-a',
        externalTransactionId: betId,
        kind: WagerTransactionKindEnum.Bet,
      },
      randomUUID(),
    );
    const win = await services[1].submit(
      {
        ...base,
        providerId: 'shared-provider-b',
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Win,
      },
      randomUUID(),
    );
    const crossProviderRefund = await services[2].submit(
      {
        ...base,
        providerId: 'shared-provider-b',
        externalTransactionId: randomUUID(),
        kind: WagerTransactionKindEnum.Refund,
        referenceExternalTransactionId: betId,
      },
      randomUUID(),
    );
    expect(bet?.status).toBe(WagerTransactionStatus.Processed);
    expect(win?.status).toBe(WagerTransactionStatus.Processed);
    expect(crossProviderRefund?.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    const current = await walletServices[0].getWallet(wallet.id);
    expect(current.balance.amount).toBe('100.00');
    expect(current.version).toBe(3);
    expect(
      await sources[0]
        .getRepository(WalletLedgerEntryEntity)
        .count({ where: { walletId: wallet.id } }),
    ).toBe(3);
    expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('processes separate wallets concurrently and reconciles each one', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () =>
        walletServices[0].createWallet({
          playerId: randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      ),
    );
    const results = await Promise.all(
      wallets.map((wallet, index) =>
        services[index % services.length].submit(
          {
            providerId: 'parallel-provider',
            externalTransactionId: randomUUID(),
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: randomUUID(),
            gameId: 'parallel-game',
            kind: WagerTransactionKindEnum.Bet,
            money: { amount: '25.00', currency: 'BRL' },
          },
          randomUUID(),
        ),
      ),
    );
    expect(results.every((result) => result?.status === 'PROCESSED')).toBe(
      true,
    );
    for (const wallet of wallets) {
      expect((await walletServices[0].getWallet(wallet.id)).balance.amount).toBe(
        '75.00',
      );
      expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
    }
  });

  it('keeps the balance correct across three independent application processes', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const roundId = randomUUID();
    const requests = Array.from({ length: 3 }, () => ({
      input: {
        providerId: 'process-provider',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'process-game',
        kind: WagerTransactionKindEnum.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      },
      idempotencyKey: `process:${randomUUID()}`,
    }));
    const workers = requests.map((request) =>
      Bun.spawn([process.execPath, 'test/fixtures/wager-worker.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          WAGER_REQUEST: JSON.stringify(request),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    const responses = await Promise.all(
      workers.map(async (worker) => {
        const [exitCode, output, errorOutput] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ]);
        if (exitCode !== 0) {
          throw new Error(`Concurrent worker failed: ${errorOutput}`);
        }
        return JSON.parse(output.trim()) as { status: string };
      }),
    );
    const debits = await sources[0]
      .getRepository(WalletLedgerEntryEntity)
      .count({
        where: { walletId: wallet.id, direction: LedgerDirection.Debit },
      });

    expect(responses.map((response) => response.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
      'REJECTED',
    ]);
    expect(debits).toBe(1);
    expect((await walletServices[1].getWallet(wallet.id)).balance.amount).toBe(
      '20.00',
    );
    expect((await walletServices[2].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('reprocesses a rollback delivered before its referenced bet', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const referenceExternalTransactionId = randomUUID();
    const roundId = randomUUID();
    const rollback = await services[0].submit(
      {
        providerId: 'reference-provider',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'reference-game',
        kind: WagerTransactionKindEnum.Rollback,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId,
      },
      `rollback:${randomUUID()}`,
    );
    expect(rollback?.status).toBe(WagerTransactionStatus.PendingReference);

    await services[1].submit(
      {
        providerId: 'reference-provider',
        externalTransactionId: referenceExternalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'reference-game',
        kind: WagerTransactionKindEnum.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      },
      `bet:${randomUUID()}`,
    );
    await sources[0].query(
      'UPDATE wager_transactions SET next_reference_attempt_at = now() WHERE id = $1',
      [rollback?.transactionId],
    );
    await services[2].reprocessPendingReferences();

    expect(
      (await services[0].getTransaction(rollback!.transactionId)).status,
    ).toBe(WagerTransactionStatus.Processed);
    expect((await walletServices[1].getWallet(wallet.id)).balance.amount).toBe(
      '100.00',
    );
    expect((await walletServices[2].reconcile(wallet.id)).consistent).toBe(true);
  });

  it('enforces wallet uniqueness and ledger immutability in PostgreSQL', async () => {
    const playerId = randomUUID();
    const wallet = await walletServices[0].createWallet({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    await expectToReject(
      walletServices[1].createWallet({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      }),
    );
    await expectToReject(
      sources[0].query('UPDATE wallets SET balance = -1.00 WHERE id = $1', [
        wallet.id,
      ]),
    );
    await expectToReject(
      sources[0].query(
        'UPDATE wallet_ledger_entries SET amount = 9.00 WHERE wallet_id = $1',
        [wallet.id],
      ),
    );

    expect((await walletServices[2].reconcile(wallet.id)).consistent).toBe(true);
  });

  sqsSuite('SQS redelivery integration', () => {
    const sqsClient = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: sqsEndpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    const integrationSqsEndpoint = sqsEndpoint ?? 'http://localhost:4566';
    const sqs = new SqsService(
      new ConfigService({
        nodeEnvironment: 'test',
        sqs: {
          endpoint: integrationSqsEndpoint,
          region: process.env.AWS_REGION ?? 'us-east-1',
          transactionQueueUrl:
            process.env.SQS_TRANSACTION_QUEUE_URL ??
            `${integrationSqsEndpoint}/000000000000/wager-transactions.fifo`,
          transactionDlqUrl: `${integrationSqsEndpoint}/000000000000/wager-transactions-dlq.fifo`,
          eventQueueUrl:
            process.env.SQS_EVENT_QUEUE_URL ??
            `${integrationSqsEndpoint}/000000000000/wager-events.fifo`,
          eventDlqUrl: `${integrationSqsEndpoint}/000000000000/wager-events-dlq.fifo`,
          localAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          localSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          visibilityTimeoutSeconds: 30,
        },
      }),
    );

    afterAll(() => {
      sqsClient.destroy();
      sqs.onModuleDestroy();
    });

    it('does not duplicate a committed wager when its SQS message is redelivered', async () => {
      const playerId = randomUUID();
      const wallet = await walletServices[0].createWallet({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const idempotencyKey = `sqs:${randomUUID()}`;
      const envelope = {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'integration-provider',
          externalTransactionId: randomUUID(),
          idempotencyKey,
          playerId,
          walletId: wallet.id,
          roundId: randomUUID(),
          gameId: 'integration-game',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      };
      const body = JSON.stringify(envelope);
      const send = await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: sqs.transactionQueueUrl,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: envelope.messageId,
        }),
      );
      const firstDelivery = (await sqs.receiveMessages()).find(
        (message) => message.messageId === send.MessageId,
      );
      expect(firstDelivery?.receiptHandle).toBeDefined();
      const payloadHash = createHash('sha256').update(body).digest('hex');
      const input = {
        ...envelope.data,
        kind: WagerTransactionKindEnum.Bet,
      } as const;

      const firstResult = await services[0].submit(input, idempotencyKey, {
        correlationId: envelope.messageId,
        inbox: {
          consumerName: 'wager-transactions-v1',
          messageId: send.MessageId!,
          payloadHash,
        },
      });
      await sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: sqs.transactionQueueUrl,
          ReceiptHandle: firstDelivery!.receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const redelivery = (await sqs.receiveMessages()).find(
        (message) => message.messageId === send.MessageId,
      );
      expect(redelivery?.receiptHandle).toBeDefined();

      const duplicateResult = await services[1].submit(input, idempotencyKey, {
        correlationId: envelope.messageId,
        inbox: {
          consumerName: 'wager-transactions-v1',
          messageId: send.MessageId!,
          payloadHash,
        },
      });
      await sqs.acknowledge(redelivery!.receiptHandle!);

      const debits = await sources[0]
        .getRepository(WalletLedgerEntryEntity)
        .count({
          where: { walletId: wallet.id, direction: LedgerDirection.Debit },
        });
      const transactionCount = await sources[0]
        .getRepository(WagerTransactionEntity)
        .count({ where: { idempotencyKey } });
      expect(firstResult?.status).toBe(WagerTransactionStatus.Processed);
      expect(duplicateResult).toBeNull();
      expect(debits).toBe(1);
      expect(transactionCount).toBe(1);
      expect((await walletServices[0].reconcile(wallet.id)).consistent).toBe(true);
    });

    it('lets concurrent outbox publishers claim a committed event only once', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL',
      );
      const eventId = randomUUID();
      const aggregateId = randomUUID();
      const occurredAt = new Date();
      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: randomUUID(),
        occurredAt: occurredAt.toISOString(),
        version: 1,
        data: { transactionId: randomUUID() },
      };
      await sources[0].query(
        `INSERT INTO outbox_messages
          (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 0, $5)`,
        [eventId, aggregateId, payload.eventType, payload, occurredAt],
      );
      const firstPublisher = new OutboxPublisher(
        sources[0],
        sqs,
        new MetricsService(),
        new StructuredLogger(),
        new OutboxRepository(),
      );
      const secondPublisher = new OutboxPublisher(
        sources[1],
        sqs,
        new MetricsService(),
        new StructuredLogger(),
        new OutboxRepository(),
      );

      const claimed = await Promise.all([
        firstPublisher.flushPendingOnce(),
        secondPublisher.flushPendingOnce(),
      ]);
      const published = await sources[0].query(
        'SELECT published_at FROM outbox_messages WHERE id = $1',
        [eventId],
      );

      expect(
        claimed.flat().filter((message) => message.id === eventId),
      ).toHaveLength(1);
      expect(published[0].published_at).toBeDefined();
    });

    it('does not let an expired publisher overwrite a newer lease', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const eventId = randomUUID();
      const aggregateId = randomUUID();
      const occurredAt = new Date();
      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: randomUUID(),
        occurredAt: occurredAt.toISOString(),
        version: 1,
        data: { transactionId: randomUUID() },
      };
      await sources[0].query(
        `INSERT INTO outbox_messages
          (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 0, $5)`,
        [eventId, aggregateId, payload.eventType, payload, occurredAt],
      );
      let firstStarted!: () => void;
      let secondStarted!: () => void;
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstReady = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const secondReady = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const originalPublish = sqs.publishEvent.bind(sqs);
      let sends = 0;
      const spy = spyOn(sqs, 'publishEvent').mockImplementation(
        async (group, id, body) => {
          sends += 1;
          if (sends === 1) {
            firstStarted();
            await firstGate;
            throw new Error('injected stale publish failure');
          }
          secondStarted();
          await secondGate;
          await originalPublish(group, id, body);
        },
      );
      const first = new OutboxPublisher(
        sources[0],
        sqs,
        new MetricsService(),
        new StructuredLogger(),
        new OutboxRepository(),
      );
      const second = new OutboxPublisher(
        sources[1],
        sqs,
        new MetricsService(),
        new StructuredLogger(),
        new OutboxRepository(),
      );
      let firstRun: Promise<unknown> | undefined;
      let secondRun: Promise<unknown> | undefined;
      try {
        firstRun = first.flushPendingOnce();
        await Promise.race([
          firstReady,
          Bun.sleep(3_000).then(() => {
            throw new Error('first publisher did not start');
          }),
        ]);
        await sources[0].query(
          "UPDATE outbox_messages SET locked_until = now() - interval '1 second' WHERE id = $1",
          [eventId],
        );
        secondRun = second.flushPendingOnce();
        await Promise.race([
          secondReady,
          Bun.sleep(3_000).then(() => {
            throw new Error('second publisher did not start');
          }),
        ]);
        const [before] = (await sources[0].query(
          'SELECT lease_token FROM outbox_messages WHERE id = $1',
          [eventId],
        )) as Array<{ lease_token: string }>;
        releaseFirst();
        await firstRun;
        const [during] = (await sources[0].query(
          'SELECT lease_token, attempts, published_at FROM outbox_messages WHERE id = $1',
          [eventId],
        )) as Array<{
          lease_token: string;
          attempts: number;
          published_at: Date | null;
        }>;
        expect(during.lease_token).toBe(before.lease_token);
        expect(during.attempts).toBe(0);
        expect(during.published_at).toBeNull();
        releaseSecond();
        await secondRun;
        const [after] = (await sources[0].query(
          'SELECT lease_token, published_at FROM outbox_messages WHERE id = $1',
          [eventId],
        )) as Array<{ lease_token: string | null; published_at: Date | null }>;
        expect(after.lease_token).toBeNull();
        expect(after.published_at).not.toBeNull();
      } finally {
        releaseFirst();
        releaseSecond();
        await Promise.allSettled(
          [firstRun, secondRun].filter((run): run is Promise<unknown> => !!run),
        );
        spy.mockRestore();
      }
    });

    it('publishes different aggregates concurrently while serializing each aggregate within a batch', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const aggregateIds = [randomUUID(), randomUUID()];
      const eventIds: string[][] = [[], []];
      const now = Date.now() - 10_000;
      for (let index = 0; index < 3; index += 1) {
        for (const [group, aggregateId] of aggregateIds.entries()) {
          const eventId = randomUUID();
          eventIds[group].push(eventId);
          const occurredAt = new Date(now + index * 10 + group);
          const payload = {
            eventId,
            eventType: 'WagerTransactionProcessed',
            aggregateId,
            correlationId: randomUUID(),
            occurredAt: occurredAt.toISOString(),
            version: 1,
            data: { transactionId: randomUUID() },
          };
          await sources[0].query(
            `INSERT INTO outbox_messages
              (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5, 0, $5)`,
            [eventId, aggregateId, payload.eventType, payload, occurredAt],
          );
        }
      }
      const originalPublish = sqs.publishEvent.bind(sqs);
      const active = new Set<string>();
      const ordered: Record<string, string[]> = {};
      let overlap = false;
      const spy = spyOn(sqs, 'publishEvent').mockImplementation(
        async (aggregateId, eventId, payload) => {
          expect(active.has(aggregateId)).toBe(false);
          if (active.size > 0) overlap = true;
          active.add(aggregateId);
          (ordered[aggregateId] ??= []).push(eventId);
          try {
            await Bun.sleep(25);
            await originalPublish(aggregateId, eventId, payload);
          } finally {
            active.delete(aggregateId);
          }
        },
      );
      try {
        const publisher = new OutboxPublisher(
          sources[0],
          sqs,
          new MetricsService(),
          new StructuredLogger(),
          new OutboxRepository(),
        );
        await publisher.flushPendingOnce();
        expect(overlap).toBe(true);
        expect(ordered[aggregateIds[0]]).toEqual(eventIds[0]);
        expect(ordered[aggregateIds[1]]).toEqual(eventIds[1]);
        const [row] = (await sources[0].query(
          'SELECT count(*)::int AS count FROM outbox_messages WHERE id = ANY($1::uuid[]) AND published_at IS NOT NULL',
          [eventIds.flat()],
        )) as Array<{ count: number }>;
        expect(row.count).toBe(6);
      } finally {
        spy.mockRestore();
      }
    });

    it('bounds concurrent sends even when a batch contains many aggregates', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const eventIds: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const eventId = randomUUID();
        const aggregateId = randomUUID();
        const occurredAt = new Date(Date.now() - 10_000 + index);
        const payload = {
          eventId,
          eventType: 'WagerTransactionProcessed',
          aggregateId,
          correlationId: randomUUID(),
          occurredAt: occurredAt.toISOString(),
          version: 1,
          data: { transactionId: randomUUID() },
        };
        eventIds.push(eventId);
        await sources[0].query(
          `INSERT INTO outbox_messages
            (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, 0, $5)`,
          [eventId, aggregateId, payload.eventType, payload, occurredAt],
        );
      }
      const originalPublish = sqs.publishEvent.bind(sqs);
      let active = 0;
      let peak = 0;
      const spy = spyOn(sqs, 'publishEvent').mockImplementation(
        async (aggregateId, eventId, payload) => {
          active += 1;
          peak = Math.max(peak, active);
          try {
            await Bun.sleep(25);
            await originalPublish(aggregateId, eventId, payload);
          } finally {
            active -= 1;
          }
        },
      );
      try {
        const publisher = new OutboxPublisher(
          sources[0],
          sqs,
          new MetricsService(),
          new StructuredLogger(),
          new OutboxRepository(),
        );
        await publisher.flushPendingOnce();
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(5);
        const [row] = (await sources[0].query(
          'SELECT count(*)::int AS count FROM outbox_messages WHERE id = ANY($1::uuid[]) AND published_at IS NOT NULL',
          [eventIds],
        )) as Array<{ count: number }>;
        expect(row.count).toBe(10);
      } finally {
        spy.mockRestore();
      }
    });

    it('waits for other aggregates and releases unstarted messages after a DLQ failure', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const failedAggregate = randomUUID();
      const eventIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const [index, eventId] of eventIds.entries()) {
        const aggregateId = index < 2 ? failedAggregate : randomUUID();
        const occurredAt = new Date(Date.now() - 10_000 + index);
        const payload = {
          eventId,
          eventType: 'WagerTransactionProcessed',
          aggregateId,
          correlationId: randomUUID(),
          occurredAt: occurredAt.toISOString(),
          version: 1,
          data: { transactionId: randomUUID() },
        };
        await sources[0].query(
          `INSERT INTO outbox_messages
            (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $5)`,
          [
            eventId,
            aggregateId,
            payload.eventType,
            payload,
            occurredAt,
            index === 0 ? 11 : 0,
          ],
        );
      }
      const originalPublish = sqs.publishEvent.bind(sqs);
      const publishSpy = spyOn(sqs, 'publishEvent').mockImplementation(
        async (aggregateId, eventId, payload) => {
          if (eventId === eventIds[0]) throw new Error('injected send failure');
          await Bun.sleep(50);
          await originalPublish(aggregateId, eventId, payload);
        },
      );
      const dlqSpy = spyOn(sqs, 'sendToEventDlq').mockRejectedValue(
        new Error('injected DLQ failure'),
      );
      try {
        const publisher = new OutboxPublisher(
          sources[0],
          sqs,
          new MetricsService(),
          new StructuredLogger(),
          new OutboxRepository(),
        );
        await expectToReject(publisher.flushPendingOnce());
        const rows = (await sources[0].query(
          'SELECT id, published_at, locked_until FROM outbox_messages WHERE id = ANY($1::uuid[])',
          [eventIds],
        )) as Array<{
          id: string;
          published_at: Date | null;
          locked_until: Date | null;
        }>;
        expect(
          rows.find((row) => row.id === eventIds[0])?.locked_until,
        ).not.toBeNull();
        expect(
          rows.find((row) => row.id === eventIds[1])?.locked_until,
        ).toBeNull();
        expect(
          rows.find((row) => row.id === eventIds[1])?.published_at,
        ).toBeNull();
        expect(
          rows.find((row) => row.id === eventIds[2])?.published_at,
        ).not.toBeNull();
      } finally {
        publishSpy.mockRestore();
        dlqSpy.mockRestore();
      }
    });

    it('waits for in-flight sends and releases remaining claims on shutdown', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const aggregateIds = [randomUUID(), randomUUID()];
      const eventIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const [index, eventId] of eventIds.entries()) {
        const aggregateId = aggregateIds[index === 2 ? 1 : 0];
        const occurredAt = new Date(Date.now() - 10_000 + index);
        const payload = {
          eventId,
          eventType: 'WagerTransactionProcessed',
          aggregateId,
          correlationId: randomUUID(),
          occurredAt: occurredAt.toISOString(),
          version: 1,
          data: { transactionId: randomUUID() },
        };
        await sources[0].query(
          `INSERT INTO outbox_messages
            (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, 0, $5)`,
          [eventId, aggregateId, payload.eventType, payload, occurredAt],
        );
      }
      let release!: () => void;
      let bothStarted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      let active = 0;
      const originalPublish = sqs.publishEvent.bind(sqs);
      const spy = spyOn(sqs, 'publishEvent').mockImplementation(
        async (aggregateId, eventId, payload) => {
          active += 1;
          if (active === 2) bothStarted();
          await gate;
          await originalPublish(aggregateId, eventId, payload);
        },
      );
      const publisher = new OutboxPublisher(
        sources[0],
        sqs,
        new MetricsService(),
        new StructuredLogger(),
        new OutboxRepository(),
      );
      try {
        publisher.onModuleInit();
        await Promise.race([
          started,
          Bun.sleep(3_000).then(() => {
            throw new Error('publishes did not start');
          }),
        ]);
        let stopped = false;
        const shutdown = publisher.onModuleDestroy().then(() => {
          stopped = true;
        });
        await Bun.sleep(20);
        expect(stopped).toBe(false);
        release();
        await shutdown;
        const rows = (await sources[0].query(
          'SELECT id, published_at, locked_until FROM outbox_messages WHERE id = ANY($1::uuid[])',
          [eventIds],
        )) as Array<{
          id: string;
          published_at: Date | null;
          locked_until: Date | null;
        }>;
        expect(
          rows.find((row) => row.id === eventIds[0])?.published_at,
        ).not.toBeNull();
        expect(
          rows.find((row) => row.id === eventIds[2])?.published_at,
        ).not.toBeNull();
        expect(
          rows.find((row) => row.id === eventIds[1])?.published_at,
        ).toBeNull();
        expect(
          rows.find((row) => row.id === eventIds[1])?.locked_until,
        ).toBeNull();
      } finally {
        release();
        await publisher.onModuleDestroy();
        spy.mockRestore();
      }
    });

    it('retries failed publication and dead-letters exhausted events', async () => {
      await sources[0].query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const eventId = randomUUID();
      const exhaustedId = randomUUID();
      const aggregateId = randomUUID();
      const now = new Date();
      const createPayload = (id: string) => ({
        eventId: id,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: randomUUID(),
        occurredAt: now.toISOString(),
        version: 1,
        data: { transactionId: randomUUID() },
      });
      for (const [id, attempts] of [
        [eventId, 0],
        [exhaustedId, 11],
      ] as const) {
        await sources[0].query(
          `INSERT INTO outbox_messages
            (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $5)`,
          [
            id,
            aggregateId,
            'WagerTransactionProcessed',
            createPayload(id),
            now,
            attempts,
          ],
        );
      }
      const brokenSqs = new SqsService(
        new ConfigService({
          nodeEnvironment: 'test',
          sqs: {
            endpoint: integrationSqsEndpoint,
            region: process.env.AWS_REGION ?? 'us-east-1',
            transactionQueueUrl: sqs.transactionQueueUrl,
            transactionDlqUrl: sqs.transactionDlqUrl,
            eventQueueUrl: `${integrationSqsEndpoint}/000000000000/missing-events.fifo`,
            eventDlqUrl: sqs.eventDlqUrl,
            localAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            localSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }),
      );
      try {
        const failingPublisher = new OutboxPublisher(
          sources[0],
          brokenSqs,
          new MetricsService(),
          new StructuredLogger(),
          new OutboxRepository(),
        );
        await failingPublisher.flushPendingOnce();
        const rows = (await sources[0].query(
          'SELECT id, attempts, published_at, dead_lettered_at FROM outbox_messages WHERE id = ANY($1::uuid[])',
          [[eventId, exhaustedId]],
        )) as Array<{
          id: string;
          attempts: number;
          published_at: Date | null;
          dead_lettered_at: Date | null;
        }>;
        const retry = rows.find((row) => row.id === eventId)!;
        const deadLetter = rows.find((row) => row.id === exhaustedId)!;
        expect(retry.attempts).toBe(1);
        expect(retry.published_at).toBeNull();
        expect(deadLetter.attempts).toBe(12);
        expect(deadLetter.dead_lettered_at).not.toBeNull();
        const messages = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: sqs.eventDlqUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          }),
        );
        const deadLetterMessage = messages.Messages?.find(
          (message) => JSON.parse(message.Body ?? '{}').eventId === exhaustedId,
        );
        expect(deadLetterMessage?.ReceiptHandle).toBeDefined();
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: sqs.eventDlqUrl,
            ReceiptHandle: deadLetterMessage!.ReceiptHandle!,
          }),
        );

        await sources[0].query(
          'UPDATE outbox_messages SET next_attempt_at = now() WHERE id = $1',
          [eventId],
        );
        const recoveryPublisher = new OutboxPublisher(
          sources[1],
          sqs,
          new MetricsService(),
          new StructuredLogger(),
          new OutboxRepository(),
        );
        await recoveryPublisher.flushPendingOnce();
        const recovered = await sources[0].query(
          'SELECT published_at FROM outbox_messages WHERE id = $1',
          [eventId],
        );
        expect(recovered[0].published_at).not.toBeNull();
      } finally {
        brokenSqs.onModuleDestroy();
      }
    });
  });
});
