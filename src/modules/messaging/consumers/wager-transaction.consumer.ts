import { createHash } from 'node:crypto';
import { HttpException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { StructuredLogger } from '../../../shared/observability/structured-logger.js';
import { PermanentMessageError } from '../../../shared/errors/domain-errors.js';
import { WageringService } from '../../wagering/services/wagering.service.js';
import { SubmitWagerDto } from '../../wagering/dtos/submit-wager.dto.js';
import { WagerTransactionKindEnum } from '../../wagering/enums/wager-transaction-kind.enum.js';
import { SqsService } from '../services/sqs.service.js';
import { WagerRequestEnvelope } from '../interfaces/wager-request-envelope.interface.js';



@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private pollTask: Promise<void> | undefined;

  constructor(
    private readonly sqs: SqsService,
    private readonly wagering: WageringService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
  ) { }

  onModuleInit(): void {
    if (!this.sqs.isConfigured) {
      this.logger.error({
        event: 'wager_queue_consumer_disabled',
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
        const messages = await this.sqs.receiveMessages();
        if (this.stopping) {
          const releaseResults = await Promise.allSettled(
            messages
              .filter((message) => message.receiptHandle)
              .map((message) => this.sqs.defer(message.receiptHandle!, 0)),
          );
          releaseResults.forEach((result) => {
            if (result.status === 'rejected') {
              this.logger.error({
                event: 'wager_queue_visibility_release_failed',
                error:
                  result.reason instanceof Error
                    ? result.reason.name
                    : 'UnknownError',
              });
            }
          });
          return;
        }
        const results = await Promise.allSettled(
          messages.map((message) => this.processMessage(message)),
        );
        for (const result of results) {
          if (result.status === 'rejected') {
            this.logger.error({
              event: 'wager_queue_message_processing_failed',
              error:
                result.reason instanceof Error
                  ? result.reason.name
                  : 'UnknownError',
            });
          }
        }
      } catch (error) {
        this.logger.error({
          event: 'wager_queue_poll_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        await this.sleep(1_000);
      }
    }
  }

  private async processMessage(
    message: Awaited<ReturnType<SqsService['receiveMessages']>>[number],
  ): Promise<void> {
    if (!message.receiptHandle || !message.body) {
      this.logger.error({
        event: 'wager_queue_message_unprocessable',
        messageId: message.messageId,
      });
      return;
    }
    try {
      const envelope = await this.parseEnvelope(message.body);
      const messageId = envelope.messageId;
      const payloadHash = createHash('sha256')
        .update(message.body)
        .digest('hex');
      const result = await this.wagering.submit(
        envelope.data,
        envelope.data.idempotencyKey,
        {
          correlationId: envelope.correlationId ?? messageId,
          inbox: {
            consumerName: 'wager-transactions-v1',
            messageId,
            payloadHash,
          },
        },
      );
      if (result?.status === 'FAILED') {
        await this.sqs.sendToTransactionDlq(
          message.body,
          message.messageId ??
          createHash('sha256').update(message.body).digest('hex'),
        );
        this.metrics.increment('dead_letter_messages');
      }
      await this.sqs.acknowledge(message.receiptHandle);
      if (result === null) {
        this.metrics.increment('inbox_duplicates_detected');
        this.metrics.increment('duplicates_detected');
      }
      this.logger.log({
        event: 'wager_queue_message_acknowledged',
        messageId,
        transportMessageId: message.messageId,
        correlationId: envelope.correlationId ?? messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        transactionId: result?.transactionId,
        status: result?.status,
      });
    } catch (error) {
      if (this.isPermanent(error)) {
        await this.sqs.sendToTransactionDlq(
          message.body,
          message.messageId ??
          createHash('sha256').update(message.body).digest('hex'),
        );
        await this.sqs.acknowledge(message.receiptHandle);
        this.metrics.increment('dead_letter_messages');
        this.logger.warn({
          event: 'wager_queue_message_dead_lettered',
          messageId: message.messageId,
          receiveCount: message.approximateReceiveCount,
        });
        return;
      }
      const retryDelay = Math.min(
        5 * 2 ** Math.max((message.approximateReceiveCount ?? 1) - 1, 0),
        300,
      );
      await this.sqs.defer(message.receiptHandle, retryDelay);
      this.metrics.increment('queue_retries');
      this.logger.error({
        event: 'wager_queue_message_retry_scheduled',
        messageId: message.messageId,
        receiveCount: message.approximateReceiveCount,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private async parseEnvelope(body: string): Promise<WagerRequestEnvelope> {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new PermanentMessageError('Queue message body is not valid JSON');
    }
    if (!value || typeof value !== 'object') {
      throw new PermanentMessageError('Queue message must be a JSON object');
    }
    const envelope = value as Record<string, unknown>;
    if (
      typeof envelope.messageId !== 'string' ||
      envelope.messageId.length === 0 ||
      envelope.messageId.length > 200 ||
      typeof envelope.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(envelope.occurredAt)) ||
      (envelope.correlationId !== undefined &&
        (typeof envelope.correlationId !== 'string' ||
          envelope.correlationId.length > 120)) ||
      envelope.type !== 'WagerTransactionRequested' ||
      !envelope.data ||
      typeof envelope.data !== 'object'
    ) {
      throw new PermanentMessageError('Queue message has an invalid envelope');
    }
    const data = envelope.data as Record<string, unknown>;
    if (
      typeof data.idempotencyKey !== 'string' ||
      data.idempotencyKey.length === 0 ||
      data.idempotencyKey.length > 255 ||
      data.kind === WagerTransactionKindEnum.Opening
    ) {
      throw new PermanentMessageError(
        'Queue message has an invalid business payload',
      );
    }
    const dto = plainToInstance(SubmitWagerDto, data);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new PermanentMessageError(
        'Queue message failed payload validation',
      );
    }
    return {
      messageId: envelope.messageId,
      type: 'WagerTransactionRequested',
      occurredAt: envelope.occurredAt,
      correlationId:
        typeof envelope.correlationId === 'string'
          ? envelope.correlationId
          : undefined,
      data: Object.assign(dto, { idempotencyKey: data.idempotencyKey }),
    };
  }

  private isPermanent(error: unknown): boolean {
    if (error instanceof PermanentMessageError) {
      return true;
    }
    return (
      error instanceof HttpException &&
      error.getStatus() >= 400 &&
      error.getStatus() < 500
    );
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
