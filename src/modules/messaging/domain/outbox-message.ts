import type { IntegrationEvent } from '../../wagering/domain/integration-events.js';
import { IntegrationEventEnvelope } from '../../wagering/interfaces/integration-event-envelope.interface.js';

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: IntegrationEventEnvelope,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _deadLetteredAt?: Date,
  ) { }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: IntegrationEventEnvelope;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt: Date;
    publishedAt?: Date;
    deadLetteredAt?: Date;
  }): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.deadLetteredAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get deadLetteredAt(): Date | undefined {
    return this._deadLetteredAt;
  }

  isPending(): boolean {
    return !this._publishedAt && !this._deadLetteredAt;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt <= now;
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  markDeadLettered(at: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._deadLetteredAt = at;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    const delay = Math.min(1_000 * 2 ** (this._attempts - 1), 300_000);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending())
      throw new Error('Outbox message is already terminal');
  }
}
