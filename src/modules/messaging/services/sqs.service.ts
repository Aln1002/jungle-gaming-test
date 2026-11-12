import { DeleteMessageCommand, ChangeMessageVisibilityCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentGlobalsEnum } from '../../../shared/enums/environment-globals.enum.js';
import { IntegrationEventEnvelope } from '../../wagering/interfaces/integration-event-envelope.interface.js';
import { ReceivedQueueMessage } from '../interfaces/received-queue-message.interface.js';

@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;
  readonly transactionQueueUrl: string;
  readonly transactionDlqUrl: string;
  readonly eventQueueUrl: string;
  readonly eventDlqUrl: string;

  constructor(private readonly configService: ConfigService) {
    const isLocal =
      this.configService.get<string>(EnvironmentGlobalsEnum.NodeEnvironment) !==
      'production';
    const endpoint = this.configService.get<string>(
      EnvironmentGlobalsEnum.SqsEndpoint,
    );
    this.client = new SQSClient({
      region: this.configService.getOrThrow<string>(
        EnvironmentGlobalsEnum.AwsRegion,
      ),
      ...(endpoint ? { endpoint } : {}),
      ...(isLocal
        ? {
          credentials: {
            accessKeyId: this.configService.getOrThrow<string>(
              EnvironmentGlobalsEnum.AwsAccessKeyId,
            ),
            secretAccessKey: this.configService.getOrThrow<string>(
              EnvironmentGlobalsEnum.AwsSecretAccessKey,
            ),
          },
        }
        : {}),
    });
    this.transactionQueueUrl = this.configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.SqsTransactionQueueUrl,
    );
    this.transactionDlqUrl = this.configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.SqsTransactionDlqUrl,
    );
    this.eventQueueUrl = this.configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.SqsEventQueueUrl,
    );
    this.eventDlqUrl = this.configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.SqsEventDlqUrl,
    );
  }

  get isConfigured(): boolean {
    return Boolean(
      this.transactionQueueUrl &&
      this.transactionDlqUrl &&
      this.eventQueueUrl &&
      this.eventDlqUrl,
    );
  }

  async receiveMessages(): Promise<ReceivedQueueMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.transactionQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        VisibilityTimeout: this.configService.getOrThrow<number>(
          EnvironmentGlobalsEnum.SqsVisibilityTimeoutSeconds,
        ),
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (response.Messages ?? []).map((message) => ({
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
      approximateReceiveCount: Number(
        message.Attributes?.ApproximateReceiveCount ?? 1,
      ),
    }));
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.transactionQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async defer(receiptHandle: string, visibilityTimeoutSeconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.transactionQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async sendToTransactionDlq(body: string, messageId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.transactionDlqUrl,
        MessageBody: body,
        MessageGroupId: messageId.slice(0, 128),
        MessageDeduplicationId: messageId.slice(0, 128),
      }),
    );
  }

  async publishEvent(aggregateId: string, eventId: string, payload: IntegrationEventEnvelope): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async sendToEventDlq(aggregateId: string, eventId: string, payload: IntegrationEventEnvelope): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventDlqUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async getDeadLetterMessageCount(): Promise<number> {
    const responses = await Promise.all(
      [this.transactionDlqUrl, this.eventDlqUrl].map((QueueUrl) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
        ),
      ),
    );
    return responses.reduce(
      (total, response) =>
        total + Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
      0,
    );
  }

  async isReady(): Promise<boolean> {
    if (!this.isConfigured) {
      return false;
    }
    try {
      await Promise.all(
        [
          this.transactionQueueUrl,
          this.transactionDlqUrl,
          this.eventQueueUrl,
          this.eventDlqUrl,
        ].map((QueueUrl) =>
          this.client.send(
            new GetQueueAttributesCommand({
              QueueUrl,
              AttributeNames: ['QueueArn'],
            }),
          ),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
