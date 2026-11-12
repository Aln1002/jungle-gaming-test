import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { configuration } from '../../config/env/configuration.js';
import { getDataSourceOptions } from '../../src/database/data-source-options.js';
import { SqsService } from '../../src/modules/messaging/services/sqs.service.js';
import { OutboxPublisher } from '../../src/modules/messaging/publishers/outbox.publisher.js';
import { OutboxRepository } from '../../src/modules/messaging/repositories/outbox.repository.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import type { SubmitWagerInput } from '../../src/modules/wagering/interfaces/submit-wager-input.interface.js';
import { WagerTransactionKindEnum } from '../../src/modules/wagering/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/enums/wager-transaction-status.enum.js';
import { MetricsService } from '../../src/shared/observability/metrics.service.js';
import { StructuredLogger } from '../../src/shared/observability/structured-logger.js';
import { expectAllWalletsReconciled } from '../fixtures/reconciliation.js';
import { createWageringRepositories, createWalletService } from '../fixtures/wagering-repositories.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_SQS_ENDPOINT;
const integrationSuite = databaseUrl && endpoint ? describe : describe.skip;

integrationSuite('Messaging process crash recovery', () => {
  const source = new DataSource({
    ...getDataSourceOptions(),
    url: databaseUrl,
    migrationsRun: false,
  });
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  const queues: Record<string, string> = {};
  const children = new Set<ChildProcess>();
  const logger = new StructuredLogger();
  const walletService = createWalletService(source);
  const wagering = new WageringService(
    source,
    new MetricsService(),
    logger,
    new ConfigService(configuration()),
    ...createWageringRepositories(),
  );

  function runWorker(mode: string, eventId?: string) {
    const child = spawn(
      process.execPath,
      ['test/fixtures/messaging-crash-worker.ts'],
      {
        env: {
          ...process.env,
          CRASH_WORKER_MODE: mode,
          CRASH_WORKER_QUEUES: JSON.stringify(queues),
          ...(eventId ? { CRASH_WORKER_EVENT_ID: eventId } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    let output = '';
    let shutdownSignaled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (
        mode === 'consumer-shutdown' &&
        !shutdownSignaled &&
        output.includes('ACK_WAITING')
      ) {
        shutdownSignaled = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const completion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${mode} timed out: ${output}`));
      }, 55_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        children.delete(child);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        children.delete(child);
        resolve({ code, signal, output });
      });
    });
    return completion;
  }

  beforeAll(async () => {
    await source.initialize();
    await source.runMigrations();
    for (const key of [
      'transactionDlqUrl',
      'eventDlqUrl',
      'transactionQueueUrl',
      'eventQueueUrl',
    ]) {
      let redrivePolicy: string | undefined;
      if (key === 'transactionQueueUrl') {
        const result = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queues.transactionDlqUrl,
            AttributeNames: ['QueueArn'],
          }),
        );
        if (!result.Attributes?.QueueArn) {
          throw new Error('Transaction DLQ has no ARN');
        }
        redrivePolicy = JSON.stringify({
          deadLetterTargetArn: result.Attributes.QueueArn,
          maxReceiveCount: '2',
        });
      }
      const result = await client.send(
        new CreateQueueCommand({
          QueueName: `crash-${key.toLowerCase()}-${randomUUID()}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            ...(redrivePolicy ? { RedrivePolicy: redrivePolicy } : {}),
          },
        }),
      );
      if (!result.QueueUrl) throw new Error(`Queue creation failed: ${key}`);
      queues[key] = result.QueueUrl;
    }
  });

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(
      Object.values(queues).map((QueueUrl) =>
        client.send(new DeleteQueueCommand({ QueueUrl })),
      ),
    );
    client.destroy();
    if (source.isInitialized) await source.destroy();
  });

  afterEach(async () => {
    if (!source.isInitialized) return;
    await expectAllWalletsReconciled(source);
  });

  it('recovers a committed message after consumer death and an event after publisher death', async () => {
    const playerId = randomUUID();
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    await source.query(
      'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
    );
    const messageId = randomUUID();
    const idempotencyKey = randomUUID();
    const message = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'crash-test-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey,
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'crash-test-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    const sent = await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
      }),
    );
    expect(sent.MessageId).toBeDefined();
    const consumerCrash = await runWorker('consumer-crash');
    expect(consumerCrash.signal).toBe('SIGKILL');

    const [transaction] = (await source.query(
      'SELECT id, status FROM wager_transactions WHERE idempotency_key = $1',
      [idempotencyKey],
    )) as Array<{ id: string; status: string }>;
    expect(transaction?.status).toBe('PROCESSED');
    const [inbox] = (await source.query(
      'SELECT processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2',
      ['wager-transactions-v1', messageId],
    )) as Array<{ processed_at: Date | null }>;
    expect(inbox?.processed_at).not.toBeNull();
    const [event] = (await source.query(
      `SELECT id, published_at FROM outbox_messages
       WHERE payload->'data'->>'transactionId' = $1 AND event_type = 'WagerTransactionProcessed'`,
      [transaction.id],
    )) as Array<{ id: string; published_at: Date | null }>;
    expect(event?.published_at).toBeNull();

    const recoveredConsumer = await runWorker('consumer-recover');
    expect(recoveredConsumer.code).toBe(0);
    expect(recoveredConsumer.output).toContain('RECOVERY_ACKNOWLEDGED');
    const replay = await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    expect(replay.MessageId).not.toBe(sent.MessageId);
    const duplicateConsumer = await runWorker('consumer-recover');
    expect(duplicateConsumer.code).toBe(0);
    expect(duplicateConsumer.output).toContain('RECOVERY_ACKNOWLEDGED');
    const conflictingBody = JSON.stringify({
      ...message,
      data: {
        ...message.data,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    });
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: conflictingBody,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const conflictConsumer = await runWorker('consumer-recover');
    expect(conflictConsumer.code).toBe(0);
    const conflictDlq = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(conflictDlq.Messages?.[0]?.Body).toBe(conflictingBody);
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        ReceiptHandle: conflictDlq.Messages![0].ReceiptHandle!,
      }),
    );
    const [counts] = (await source.query(
      `SELECT
           (SELECT COUNT(*)::int FROM wager_transactions WHERE idempotency_key = $1) AS transactions,
           (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE transaction_id = $2) AS entries,
           (SELECT COUNT(*)::int FROM outbox_messages WHERE payload->'data'->>'transactionId' = $2::text) AS events`,
      [idempotencyKey, transaction.id],
    )) as Array<{ transactions: number; entries: number; events: number }>;
    expect(counts).toEqual({ transactions: 1, entries: 1, events: 2 });
    expect((await walletService.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect((await walletService.reconcile(wallet.id)).consistent).toBe(true);

    const publisherCrash = await runWorker('publisher-crash');
    expect(publisherCrash.signal).toBe('SIGKILL');
    const [claimed] = (await source.query(
      'SELECT published_at, locked_until FROM outbox_messages WHERE id = $1',
      [event.id],
    )) as Array<{ published_at: Date | null; locked_until: Date | null }>;
    expect(claimed.published_at).toBeNull();
    expect(claimed.locked_until).not.toBeNull();

    const firstDelivery = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventQueueUrl,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 45,
      }),
    );
    const delivered = firstDelivery.Messages?.[0];
    expect(delivered?.ReceiptHandle).toBeDefined();
    const firstEventId = JSON.parse(delivered!.Body!).eventId as string;
    const [firstOutbox] = (await source.query(
      'SELECT published_at, locked_until FROM outbox_messages WHERE id = $1',
      [firstEventId],
    )) as Array<{ published_at: Date | null; locked_until: Date | null }>;
    expect(firstOutbox.published_at).toBeNull();
    expect(firstOutbox.locked_until).not.toBeNull();
    const recoveredPublisher = await runWorker('publisher-recover', event.id);
    expect(recoveredPublisher.code).toBe(0);
    expect(recoveredPublisher.output).toContain('RECOVERY_PUBLISHED');
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.eventQueueUrl,
        ReceiptHandle: delivered!.ReceiptHandle!,
      }),
    );
    const secondDelivery = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventQueueUrl,
        WaitTimeSeconds: 2,
      }),
    );
    const second = secondDelivery.Messages?.[0];
    expect(second?.ReceiptHandle).toBeDefined();
    expect(JSON.parse(second!.Body!).eventId).not.toBe(firstEventId);
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.eventQueueUrl,
        ReceiptHandle: second!.ReceiptHandle!,
      }),
    );
    const duplicate = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventQueueUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(duplicate.Messages ?? []).toHaveLength(0);
  }, 90_000);

  it('deduplicates actual duplicate integration-event deliveries and redelivery after commit', async () => {
    const queue = await client.send(
      new CreateQueueCommand({
        QueueName: `downstream-${randomUUID()}.fifo`,
        Attributes: { FifoQueue: 'true' },
      }),
    );
    if (!queue.QueueUrl) throw new Error('Test event queue has no URL');
    const queueUrl = queue.QueueUrl;
    const sqs = new SqsService(
      new ConfigService({
        nodeEnvironment: 'test',
        sqs: {
          ...queues,
          eventQueueUrl: queueUrl,
          endpoint,
          region: process.env.AWS_REGION ?? 'us-east-1',
          localAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          localSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        },
      }),
    );
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(
        'CREATE TEMP TABLE downstream_seen (event_id uuid PRIMARY KEY)',
      );
      await runner.query(
        'CREATE TEMP TABLE downstream_effects (event_id uuid PRIMARY KEY)',
      );
      await source.query(
        'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND dead_lettered_at IS NULL',
      );
      const wallet = await walletService.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });
      const [event] = (await source.query(
        `SELECT id FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WalletBalanceChanged'`,
        [wallet.id],
      )) as Array<{ id: string }>;
      expect(event).toBeDefined();
      await new OutboxPublisher(
        source,
        sqs,
        new MetricsService(),
        logger,
        new OutboxRepository(),
      ).flushPendingOnce();

      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 30,
        }),
      );
      const delivery = received.Messages?.find(
        (item) => JSON.parse(item.Body ?? '{}').eventId === event.id,
      );
      expect(delivery?.Body).toBeDefined();
      expect(delivery?.ReceiptHandle).toBeDefined();
      for (const other of received.Messages ?? []) {
        if (other !== delivery && other.ReceiptHandle) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: other.ReceiptHandle,
            }),
          );
        }
      }
      const apply = async (body: string, failBeforeCommit = false) => {
        const eventId = (JSON.parse(body) as { eventId: string }).eventId;
        await runner.startTransaction();
        try {
          const inserted = (await runner.query(
            'INSERT INTO downstream_seen(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
            [eventId],
          )) as Array<{ event_id: string }>;
          if (inserted.length) {
            await runner.query(
              'INSERT INTO downstream_effects(event_id) VALUES ($1)',
              [eventId],
            );
          }
          if (failBeforeCommit) throw new Error('injected downstream failure');
          await runner.commitTransaction();
        } catch (error) {
          await runner.rollbackTransaction();
          throw error;
        }
      };
      const failure = await apply(delivery!.Body!, true).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error))
        throw new Error('Expected downstream failure');
      expect(failure.message).toBe('injected downstream failure');
      const [rolledBack] = (await runner.query(
        `SELECT (SELECT count(*)::int FROM downstream_seen) AS seen,
                (SELECT count(*)::int FROM downstream_effects) AS effects`,
      )) as Array<{ seen: number; effects: number }>;
      expect(rolledBack).toEqual({ seen: 0, effects: 0 });
      await apply(delivery!.Body!);
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: delivery!.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );
      const redelivery = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 30,
        }),
      );
      const retried = redelivery.Messages?.find(
        (item) => item.Body === delivery!.Body,
      );
      expect(retried?.ReceiptHandle).toBeDefined();
      await apply(retried!.Body!);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: retried!.ReceiptHandle!,
        }),
      );

      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: delivery!.Body!,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const duplicate = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 30,
        }),
      );
      const duplicateMessage = duplicate.Messages?.find(
        (item) => item.Body === delivery!.Body,
      );
      expect(duplicateMessage?.ReceiptHandle).toBeDefined();
      await apply(duplicateMessage!.Body!);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: duplicateMessage!.ReceiptHandle!,
        }),
      );
      const [counts] = (await runner.query(
        `SELECT (SELECT count(*)::int FROM downstream_seen) AS seen,
                (SELECT count(*)::int FROM downstream_effects) AS effects`,
      )) as Array<{ seen: number; effects: number }>;
      expect(counts).toEqual({ seen: 1, effects: 1 });
      expect((await walletService.reconcile(wallet.id)).consistent).toBe(true);
    } finally {
      await runner.release();
      sqs.onModuleDestroy();
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  }, 30_000);

  it('finishes an in-flight message before stopping on SIGTERM', async () => {
    const playerId = randomUUID();
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const messageId = randomUUID();
    const idempotencyKey = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'shutdown-provider',
            externalTransactionId: randomUUID(),
            idempotencyKey,
            playerId,
            walletId: wallet.id,
            roundId: randomUUID(),
            gameId: 'shutdown-game',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
      }),
    );
    const stopped = await runWorker('consumer-shutdown');
    expect(stopped.code).toBe(0);
    expect(stopped.output).toContain('SHUTDOWN_STARTED');
    expect(stopped.output.indexOf('ACK_FINISHED')).toBeGreaterThan(
      stopped.output.indexOf('SHUTDOWN_STARTED'),
    );
    expect(stopped.output.indexOf('SHUTDOWN_COMPLETED')).toBeGreaterThan(
      stopped.output.indexOf('ACK_FINISHED'),
    );
    const remaining = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(remaining.Messages ?? []).toHaveLength(0);
    expect((await walletService.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect((await walletService.reconcile(wallet.id)).consistent).toBe(true);
  }, 60_000);

  it('moves an invalid message to the transaction DLQ through the running consumer', async () => {
    const id = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: '{invalid',
        MessageGroupId: id,
        MessageDeduplicationId: id,
      }),
    );
    const consumer = await runWorker('consumer-recover');
    expect(consumer.code).toBe(0);
    expect(consumer.output).toContain('RECOVERY_ACKNOWLEDGED');
    const delivery = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(delivery.Messages?.[0]?.Body).toBe('{invalid');
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        ReceiptHandle: delivery.Messages![0].ReceiptHandle!,
      }),
    );
    const oversizedId = randomUUID();
    const oversizedBody = JSON.stringify({
      messageId: oversizedId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'oversized-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: randomUUID(),
        gameId: 'oversized-game',
        kind: 'BET',
        money: { amount: '1000000000000000000.00', currency: 'BRL' },
      },
    });
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: oversizedBody,
        MessageGroupId: oversizedId,
        MessageDeduplicationId: oversizedId,
      }),
    );
    expect((await runWorker('consumer-recover')).code).toBe(0);
    const oversizedDlq = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(oversizedDlq.Messages?.[0]?.Body).toBe(oversizedBody);
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        ReceiptHandle: oversizedDlq.Messages![0].ReceiptHandle!,
      }),
    );
    const arrayId = randomUUID();
    const arrayBody = JSON.stringify({
      messageId: arrayId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'array-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: randomUUID(),
        gameId: 'array-game',
        kind: 'BET',
        money: [{ amount: '1.00', currency: 'BRL' }],
      },
    });
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageBody: arrayBody,
        MessageGroupId: arrayId,
        MessageDeduplicationId: arrayId,
      }),
    );
    expect((await runWorker('consumer-recover')).code).toBe(0);
    const arrayDlq = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(arrayDlq.Messages?.[0]?.Body).toBe(arrayBody);
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.transactionDlqUrl,
        ReceiptHandle: arrayDlq.Messages![0].ReceiptHandle!,
      }),
    );
  }, 60_000);

  it('redelivers a persisted FAILED message when sending it to the DLQ fails', async () => {
    const playerId = randomUUID();
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const idempotencyKey = randomUUID();
    const messageId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_permission_ledger_${suffix}`;
    const triggerName = `test_permission_${suffix}`;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'permission-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey,
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'permission-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
    await source.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RAISE EXCEPTION 'injected permission failure' USING ERRCODE = '42501'; END; $$`,
    );
    try {
      await source.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON wallet_ledger_entries
         FOR EACH ROW WHEN (NEW.wallet_id = '${wallet.id}'::uuid)
         EXECUTE FUNCTION ${functionName}()`,
      );
      await client.send(
        new SendMessageCommand({
          QueueUrl: queues.transactionQueueUrl,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: messageId,
        }),
      );
      const first = await runWorker('consumer-dlq-fail-once');
      expect(first.code).toBe(0);
      expect(first.output).toContain('RETRY_SCHEDULED:5');
      const [row] = (await source.query(
        `SELECT id, status, failure_code, processed_at FROM wager_transactions
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      )) as Array<{
        id: string;
        status: string;
        failure_code: string;
        processed_at: Date | null;
      }>;
      expect(row.status).toBe('FAILED');
      expect(row.failure_code).toBe('INFRASTRUCTURE_PERMISSION_DENIED');
      expect(row.processed_at).not.toBeNull();
      const [event] = (await source.query(
        `SELECT count(*)::int AS count FROM outbox_messages
         WHERE event_type = 'WagerTransactionFailed' AND payload->'data'->>'transactionId' = $1`,
        [row.id],
      )) as Array<{ count: number }>;
      expect(event.count).toBe(1);
      const [inbox] = (await source.query(
        `SELECT processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`,
        ['wager-transactions-v1', messageId],
      )) as Array<{ processed_at: Date | null }>;
      expect(inbox.processed_at).not.toBeNull();
      const recovery = await runWorker('consumer-recover');
      expect(recovery.code).toBe(0);
      expect(recovery.output).toContain('RECOVERY_ACKNOWLEDGED');
      const deadLetter = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.transactionDlqUrl,
          WaitTimeSeconds: 5,
        }),
      );
      expect(deadLetter.Messages?.[0]?.Body).toBe(body);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queues.transactionDlqUrl,
          ReceiptHandle: deadLetter.Messages![0].ReceiptHandle!,
        }),
      );
      const [ledger] = (await source.query(
        'SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = $1',
        [row.id],
      )) as Array<{ count: number }>;
      expect(ledger.count).toBe(0);
      expect((await walletService.getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
    } finally {
      await source.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON wallet_ledger_entries`,
      );
      await source.query(`DROP FUNCTION ${functionName}()`);
    }
  }, 70_000);

  it('retries a transient processing failure with backoff and redrives it to the DLQ', async () => {
    const playerId = randomUUID();
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const idempotencyKey = randomUUID();
    const messageId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_retry_outbox_${suffix}`;
    const triggerName = `test_retry_${suffix}`;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'retry-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey,
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'retry-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
    await source.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION 'injected processing failure'; END; $$`,
    );
    try {
      await source.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
           FOR EACH ROW WHEN (NEW.aggregate_id = '${wallet.id}'::uuid)
           EXECUTE FUNCTION ${functionName}()`,
      );
      await client.send(
        new SendMessageCommand({
          QueueUrl: queues.transactionQueueUrl,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: messageId,
        }),
      );
      const first = await runWorker('consumer-retry-once');
      expect(first.code).toBe(0);
      expect(first.output).toContain('RETRY_SCHEDULED:5');
      const second = await runWorker('consumer-retry-once');
      expect(second.code).toBe(0);
      expect(second.output).toContain('RETRY_SCHEDULED:10');
      await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.transactionQueueUrl,
          WaitTimeSeconds: 15,
        }),
      );
      const deadLetter = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.transactionDlqUrl,
          WaitTimeSeconds: 5,
        }),
      );
      expect(deadLetter.Messages?.[0]?.Body).toBe(body);
      const [row] = (await source.query(
        'SELECT COUNT(*)::int AS count FROM wager_transactions WHERE idempotency_key = $1',
        [idempotencyKey],
      )) as Array<{ count: number }>;
      expect(row.count).toBe(0);
      expect((await walletService.getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
      expect((await walletService.reconcile(wallet.id)).consistent).toBe(true);
    } finally {
      await source.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON outbox_messages`,
      );
      await source.query(`DROP FUNCTION ${functionName}()`);
    }
  }, 70_000);

  it('rolls back inbox, transaction, ledger, balance and outbox when event insertion fails', async () => {
    const playerId = randomUUID();
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const idempotencyKey = randomUUID();
    const messageId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_fail_outbox_${suffix}`;
    const triggerName = `test_outbox_${suffix}`;
    const input: SubmitWagerInput = {
      providerId: 'atomicity-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'atomicity-game',
      kind: WagerTransactionKindEnum.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const context = {
      inbox: {
        consumerName: 'atomicity-test',
        messageId,
        payloadHash: 'a'.repeat(64),
      },
    };
    await source.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RAISE EXCEPTION 'injected outbox failure'; END; $$`,
    );
    try {
      await source.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
         FOR EACH ROW WHEN (NEW.aggregate_id = '${wallet.id}'::uuid)
         EXECUTE FUNCTION ${functionName}()`,
      );
      const failure = await wagering
        .submit(input, idempotencyKey, context)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('injected outbox failure');
      const [counts] = (await source.query(
        `SELECT
           (SELECT COUNT(*)::int FROM inbox_messages WHERE consumer_name = 'atomicity-test' AND message_id = $1) AS inbox,
           (SELECT COUNT(*)::int FROM wager_transactions WHERE idempotency_key = $2) AS transactions,
           (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = $3 AND direction = 'DEBIT') AS debits,
           (SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = $3 AND payload->'data'->>'kind' = 'BET') AS events`,
        [messageId, idempotencyKey, wallet.id],
      )) as Array<{
        inbox: number;
        transactions: number;
        debits: number;
        events: number;
      }>;
      expect(counts).toEqual({
        inbox: 0,
        transactions: 0,
        debits: 0,
        events: 0,
      });
      expect((await walletService.getWallet(wallet.id)).balance.amount).toBe(
        '100.00',
      );
      expect((await walletService.reconcile(wallet.id)).consistent).toBe(true);
    } finally {
      await source.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON outbox_messages`,
      );
      await source.query(`DROP FUNCTION ${functionName}()`);
    }
    const retried = await wagering.submit(input, idempotencyKey, context);
    expect(retried?.status).toBe(WagerTransactionStatus.Processed);
    expect((await walletService.getWallet(wallet.id)).balance.amount).toBe('90.00');
    expect((await walletService.reconcile(wallet.id)).consistent).toBe(true);
  });
});
