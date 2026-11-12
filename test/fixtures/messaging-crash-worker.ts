import { ConfigService } from '@nestjs/config';
import { configuration } from '../../config/env/configuration.js';
import { DataSource } from 'typeorm';
import { getDataSourceOptions } from '../../src/database/data-source-options.js';
import { WagerTransactionConsumer } from '../../src/modules/messaging/consumers/wager-transaction.consumer.js';
import { OutboxPublisher } from '../../src/modules/messaging/publishers/outbox.publisher.js';
import { OutboxRepository } from '../../src/modules/messaging/repositories/outbox.repository.js';
import { SqsService } from '../../src/modules/messaging/services/sqs.service.js';
import type { IntegrationEventEnvelope } from '../../src/modules/wagering/interfaces/integration-event-envelope.interface.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import { MetricsService } from '../../src/shared/observability/metrics.service.js';
import { StructuredLogger } from '../../src/shared/observability/structured-logger.js';
import { createWageringRepositories } from './wagering-repositories.js';

const mode = process.env.CRASH_WORKER_MODE;
const queueConfig = JSON.parse(process.env.CRASH_WORKER_QUEUES ?? '') as {
  transactionQueueUrl: string;
  transactionDlqUrl: string;
  eventQueueUrl: string;
  eventDlqUrl: string;
};
const endpoint = process.env.TEST_SQS_ENDPOINT;
if (!endpoint || !process.env.TEST_DATABASE_URL) {
  throw new Error('Isolated test database and SQS endpoint are required');
}

class CrashSqsService extends SqsService {
  override async defer(
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await super.defer(receiptHandle, visibilityTimeoutSeconds);
    if (mode === 'consumer-retry-once' || mode === 'consumer-dlq-fail-once') {
      console.log(`RETRY_SCHEDULED:${visibilityTimeoutSeconds}`);
      process.exit(0);
    }
  }

  override async sendToTransactionDlq(
    body: string,
    messageId: string,
  ): Promise<void> {
    if (mode === 'consumer-dlq-fail-once') {
      throw new Error('Injected DLQ send failure');
    }
    await super.sendToTransactionDlq(body, messageId);
  }

  override async acknowledge(receiptHandle: string): Promise<void> {
    if (mode === 'consumer-crash') {
      process.kill(process.pid, 'SIGKILL');
    }
    if (mode === 'consumer-shutdown') {
      console.log('ACK_WAITING');
      await Bun.sleep(1_000);
    }
    await super.acknowledge(receiptHandle);
    if (mode === 'consumer-shutdown') {
      console.log('ACK_FINISHED');
    }
    if (mode === 'consumer-recover') {
      console.log('RECOVERY_ACKNOWLEDGED');
      process.exit(0);
    }
  }

  override async publishEvent(
    aggregateId: string,
    eventId: string,
    payload: IntegrationEventEnvelope,
  ): Promise<void> {
    await super.publishEvent(aggregateId, eventId, payload);
    if (mode === 'publisher-crash') {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}

const source = new DataSource({
  ...getDataSourceOptions(),
  url: process.env.TEST_DATABASE_URL,
  migrationsRun: false,
});
const sqs = new CrashSqsService(
  new ConfigService({
    nodeEnvironment: 'test',
    sqs: {
      ...queueConfig,
      endpoint,
      region: process.env.AWS_REGION ?? 'us-east-1',
      localAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      localSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      visibilityTimeoutSeconds: 2,
    },
  }),
);
const metrics = new MetricsService();
const logger = new StructuredLogger();
await source.initialize();

if (
  mode === 'consumer-crash' ||
  mode === 'consumer-recover' ||
  mode === 'consumer-retry-once' ||
  mode === 'consumer-dlq-fail-once' ||
  mode === 'consumer-shutdown'
) {
  const consumer = new WagerTransactionConsumer(
    sqs,
    new WageringService(
      source,
      metrics,
      logger,
      new ConfigService(configuration()),
      ...createWageringRepositories(),
    ),
    metrics,
    logger,
  );
  consumer.onModuleInit();
  if (mode === 'consumer-shutdown') {
    process.once('SIGTERM', () => {
      console.log('SHUTDOWN_STARTED');
      void (async () => {
        await consumer.onModuleDestroy();
        await source.destroy();
        sqs.onModuleDestroy();
        console.log('SHUTDOWN_COMPLETED');
        process.exit(0);
      })().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
    });
  }
} else if (mode === 'publisher-crash' || mode === 'publisher-recover') {
  const publisher = new OutboxPublisher(
    source,
    sqs,
    metrics,
    logger,
    new OutboxRepository(),
  );
  if (mode === 'publisher-crash') {
    await publisher.flushPendingOnce();
    throw new Error('Publisher did not reach the crash point');
  }
  const eventId = process.env.CRASH_WORKER_EVENT_ID;
  if (!eventId) throw new Error('CRASH_WORKER_EVENT_ID is required');
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await publisher.flushPendingOnce();
    const [row] = (await source.query(
      'SELECT published_at FROM outbox_messages WHERE id = $1',
      [eventId],
    )) as Array<{ published_at: Date | null }>;
    if (row?.published_at) {
      console.log('RECOVERY_PUBLISHED');
      await source.destroy();
      sqs.onModuleDestroy();
      process.exit(0);
    }
    await Bun.sleep(250);
  }
  throw new Error('Publisher failed to recover the expired lease');
} else {
  throw new Error('Unknown crash worker mode');
}
