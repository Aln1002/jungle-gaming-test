import { EntityManager } from 'typeorm';
import { InboxMessageEntity } from '../../../database/entities/inbox-message.entity.js';
import { BaseRepository } from '../../../shared/repositories/base.repository.js';
import { InboxMessage } from '../domain/inbox-message.js';

export class InboxRepository extends BaseRepository<InboxMessageEntity> {
  constructor() {
    super(InboxMessageEntity);
  }

  async receive(manager: EntityManager, message: InboxMessage) {
    const repository = this.repository(manager);
    await repository
      .createQueryBuilder()
      .insert()
      .values({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: null,
      })
      .orIgnore()
      .execute();
    return repository.findOne({
      where: {
        consumerName: message.consumerName,
        messageId: message.messageId,
      },
      lock: { mode: 'pessimistic_write' },
    });
  }

  markProcessed(manager: EntityManager, message: InboxMessage) {
    return this.repository(manager).update(
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt },
    );
  }
}
