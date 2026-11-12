import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ConfigModule } from '@nestjs/config';
import {
  getEnvironment,
  getEnvironmentFilePaths,
} from '../config/env/configuration.js';

ConfigModule.forRoot({ envFilePath: getEnvironmentFilePaths() });
const environment = getEnvironment();
const endpoint = environment.sqs.endpoint ?? 'http://localhost:4566';
const client = new SQSClient({
  region: environment.sqs.region,
  endpoint,
  credentials: {
    accessKeyId: environment.sqs.localAccessKeyId,
    secretAccessKey: environment.sqs.localSecretAccessKey,
  },
});

async function createFifoQueue(
  queueName: string,
  additionalAttributes: Record<string, string> = {},
): Promise<{ url: string; arn: string }> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...additionalAttributes,
      },
    }),
  );
  if (!QueueUrl) {
    throw new Error(`Queue ${queueName} was created without a URL`);
  }
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) {
    throw new Error(`Queue ${queueName} was created without an ARN`);
  }
  return { url: QueueUrl, arn };
}

try {
  const transactionDlq = await createFifoQueue('wager-transactions-dlq.fifo');
  const eventDlq = await createFifoQueue('wager-events-dlq.fifo');
  await createFifoQueue('wager-transactions.fifo', {
    VisibilityTimeout: '30',
    ReceiveMessageWaitTimeSeconds: '20',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: transactionDlq.arn,
      maxReceiveCount: '5',
    }),
  });
  await createFifoQueue('wager-events.fifo', {
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: eventDlq.arn,
      maxReceiveCount: '5',
    }),
  });
  console.log(
    'Created local FIFO queues for wager transactions and integration events',
  );
} finally {
  client.destroy();
}
