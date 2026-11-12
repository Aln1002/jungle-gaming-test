import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module.js';
import { OutboxPublisher } from './publishers/outbox.publisher.js';
import { PendingReferenceWorker } from './workers/pending-reference.worker.js';
import { SqsService } from './services/sqs.service.js';
import { WagerTransactionConsumer } from './consumers/wager-transaction.consumer.js';

@Module({
  imports: [WageringModule],
  providers: [
    SqsService,
    OutboxPublisher,
    PendingReferenceWorker,
    WagerTransactionConsumer,
  ],
  exports: [SqsService],
})
export class MessagingModule {}
