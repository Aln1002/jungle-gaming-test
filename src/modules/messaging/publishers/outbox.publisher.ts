import { DataSource } from 'typeorm';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { StructuredLogger } from '../../../shared/observability/structured-logger.js';
import { SqsService } from '../services/sqs.service.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import { OutboxRepository } from '../repositories/outbox.repository.js';
import type { ClaimedOutboxMessage } from '../interfaces/claimed-outbox-message.interface.js';

const OUTBOX_MAX_ATTEMPTS = 12;
const OUTBOX_LOCK_SECONDS = 30;
const OUTBOX_BATCH_SIZE = 10;
const OUTBOX_PUBLISH_CONCURRENCY = 5;
const OUTBOX_METRICS_INTERVAL_MS = 1_000;

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private pollTask: Promise<void> | undefined;
  private lastMetricsUpdate = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sqs: SqsService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
    private readonly outboxRepository: OutboxRepository
  ) {}

  onModuleInit(): void {
    if (!this.sqs.isConfigured) {
      this.logger.error({
        event: 'outbox_publisher_disabled',
        reason: 'SQS queue URLs are not configured',
      });
      return;
    }
    this.pollTask = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.pollTask;
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const messages = await this.flushPendingOnce();
        if (messages.length === 0) {
          await this.sleep(500);
        }
      } catch (error) {
        this.logger.error({
          event: 'outbox_poll_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        await this.sleep(1_000);
      }
    }
  }

  async flushPendingOnce(): Promise<ClaimedOutboxMessage[]> {
    const messages = await this.claimBatch(OUTBOX_BATCH_SIZE);
    messages.sort(
      (left, right) =>
        left.occurred_at.getTime() - right.occurred_at.getTime() ||
        left.id.localeCompare(right.id),
    );
    const groups = new Map<string, ClaimedOutboxMessage[]>();
    for (const message of messages) {
      const group = groups.get(message.aggregate_id) ?? [];
      group.push(message);
      groups.set(message.aggregate_id, group);
    }
    const batches = [...groups.values()];
    let next = 0;
    const failures: unknown[] = [];
    const workers = await Promise.allSettled(
      Array.from(
        { length: Math.min(OUTBOX_PUBLISH_CONCURRENCY, batches.length) },
        async () => {
          for (;;) {
            const group = batches[next++];
            if (!group) return;
            for (const [index, message] of group.entries()) {
              if (this.stopping) {
                await this.releaseClaims(group.slice(index));
                break;
              }
              try {
                await this.publish(message);
              } catch (error) {
                failures.push(error);
                await this.releaseClaims(group.slice(index + 1));
                break;
              }
            }
          }
        },
      ),
    );
    for (const worker of workers) {
      if (worker.status === 'rejected') failures.push(worker.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Outbox publication failed');
    }
    if (Date.now() - this.lastMetricsUpdate >= OUTBOX_METRICS_INTERVAL_MS) {
      await this.updateOutboxLag();
      this.lastMetricsUpdate = Date.now();
    }
    return messages;
  }

  private async releaseClaims(messages: ClaimedOutboxMessage[]): Promise<void> {
    await this.outboxRepository.releaseClaims(this.dataSource.manager, messages);
  }

  private async claimBatch(limit: number): Promise<ClaimedOutboxMessage[]> {
    return this.outboxRepository.claimBatch(this.dataSource, limit, OUTBOX_LOCK_SECONDS);
  }

  private async publish(message: ClaimedOutboxMessage): Promise<void> {
    const event = OutboxMessage.rehydrate({
      id: message.id,
      aggregateId: message.aggregate_id,
      eventType: message.payload.eventType,
      payload: message.payload,
      occurredAt: message.occurred_at,
      attempts: message.attempts,
      nextAttemptAt: message.next_attempt_at,
    });
    try {
      await this.sqs.publishEvent(
        message.aggregate_id,
        message.id,
        message.payload,
      );
    } catch (error) {
      const attempts = event.attempts + 1;
      if (attempts >= OUTBOX_MAX_ATTEMPTS) {
        const owned = await this.outboxRepository.renewLease(
          this.dataSource.manager,
          message,
          OUTBOX_LOCK_SECONDS,
        );
        if (owned === 0) {
          this.logLostLease(message);
          return;
        }
        await this.sqs.sendToEventDlq(
          message.aggregate_id,
          message.id,
          message.payload,
        );
        const count = await this.outboxRepository.markDeadLettered(
          this.dataSource.manager,
          message,
          attempts,
        );
        if (count === 0) {
          this.logLostLease(message);
          return;
        }
        this.metrics.increment('event_dead_letter_messages');
        this.logger.error({
          event: 'outbox_event_dead_lettered',
          eventId: message.id,
          aggregateId: message.aggregate_id,
          attempts,
        });
        return;
      }
      event.scheduleRetry(new Date());
      const count = await this.outboxRepository.scheduleRetry(
        this.dataSource.manager,
        message,
        attempts,
        event.nextAttemptAt,
      );
      if (count === 0) {
        this.logLostLease(message);
        return;
      }
      this.metrics.increment('outbox_retries');
      this.logger.error({
        event: 'outbox_event_publish_failed',
        eventId: message.id,
        aggregateId: message.aggregate_id,
        attempts,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return;
    }
    const count = await this.outboxRepository.markPublished(
      this.dataSource.manager,
      message,
    );
    if (count === 0) {
      this.logLostLease(message);
      return;
    }
    this.metrics.increment('outbox_events_published');
  }

  private logLostLease(message: ClaimedOutboxMessage): void {
    this.logger.warn({
      event: 'outbox_lease_lost',
      eventId: message.id,
      aggregateId: message.aggregate_id,
    });
  }

  private async updateOutboxLag(): Promise<void> {
    this.metrics.setOutboxLag(await this.outboxRepository.lag(this.dataSource.manager));
    try {
      this.metrics.setDeadLetterMessages(
        await this.sqs.getDeadLetterMessageCount(),
      );
    } catch (error) {
      this.logger.warn({
        event: 'dead_letter_metric_unavailable',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
