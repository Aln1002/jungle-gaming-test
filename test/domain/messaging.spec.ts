import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message.js';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message.js';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/integration-events.js';
import { WagerTransactionKindEnum } from '../../src/modules/wagering/enums/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/modules/wagering/enums/wager-transaction-status.enum.js';

describe('Messaging domain', () => {
  it('rehydrates inbox state and prevents repeat transitions', () => {
    const now = new Date();
    const message = InboxMessage.receive({
      consumerName: 'consumer',
      messageId: 'message',
      payloadHash: 'a'.repeat(64),
      receivedAt: now,
    });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(now);
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(now)).toThrow();
    expect(
      InboxMessage.rehydrate({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt,
      }).isProcessed(),
    ).toBe(true);
  });

  it('enqueues events and enforces retry and terminal states', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const event = new WagerTransactionProcessed({
      aggregateId: 'wallet',
      correlationId: 'correlation',
      occurredAt: now,
      data: {
        transactionId: 'transaction',
        providerId: 'provider',
        walletId: 'wallet',
        kind: WagerTransactionKindEnum.Bet,
        status: WagerTransactionStatus.Processed,
      },
    });
    const message = OutboxMessage.enqueue(event);
    expect(message.payload.eventId).toBe(event.eventId);
    expect(message.isDue(now)).toBe(true);
    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.isDue(now)).toBe(false);
    expect(message.nextAttemptAt.getTime()).toBe(now.getTime() + 1_000);
    message.markPublished(message.nextAttemptAt);
    expect(message.isPending()).toBe(false);
    expect(() => message.scheduleRetry(now)).toThrow();
    expect(() => message.markDeadLettered(now)).toThrow();
  });
});
