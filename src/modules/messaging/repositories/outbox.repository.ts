import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxMessageEntity } from '../../../database/entities/outbox-message.entity.js';
import { BaseRepository } from '../../../shared/repositories/base.repository.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import type { IntegrationEvent } from '../../wagering/domain/integration-events.js';
import { ClaimedOutboxMessage } from '../interfaces/claimed-outbox-message.interface.js';



export class OutboxRepository extends BaseRepository<OutboxMessageEntity> {
  constructor() {
    super(OutboxMessageEntity);
  }

  async enqueue(
    manager: EntityManager,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await manager.query(
      `INSERT INTO outbox_messages
        (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 0, $5)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
      ],
    );
  }

  async claimBatch(
    source: DataSource,
    limit: number,
    lockSeconds: number,
  ): Promise<ClaimedOutboxMessage[]> {
    return source.transaction(async (manager) => {
      const [rows] = (await manager.query(
        `WITH candidates AS (
           SELECT id
           FROM outbox_messages
           WHERE published_at IS NULL
             AND dead_lettered_at IS NULL
             AND next_attempt_at <= now()
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY occurred_at ASC, id ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_messages AS outbox
         SET locked_until = now() + ($2 * interval '1 second'), lease_token = $3
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.id, outbox.aggregate_id, outbox.payload, outbox.occurred_at, outbox.attempts, outbox.next_attempt_at, outbox.lease_token`,
        [limit, lockSeconds, randomUUID()],
      )) as [ClaimedOutboxMessage[], number];
      return rows;
    });
  }

  async releaseClaims(
    manager: EntityManager,
    messages: ClaimedOutboxMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;
    await manager.query(
      `UPDATE outbox_messages SET locked_until = NULL, lease_token = NULL
       WHERE id = ANY($1::uuid[]) AND lease_token = $2
         AND published_at IS NULL AND dead_lettered_at IS NULL`,
      [messages.map((message) => message.id), messages[0].lease_token],
    );
  }

  async renewLease(
    manager: EntityManager,
    message: ClaimedOutboxMessage,
    lockSeconds: number,
  ): Promise<number> {
    const [, count] = (await manager.query(
      `UPDATE outbox_messages
       SET locked_until = now() + ($3 * interval '1 second')
       WHERE id = $1 AND lease_token = $2 AND locked_until > now()
         AND published_at IS NULL AND dead_lettered_at IS NULL
       RETURNING id`,
      [message.id, message.lease_token, lockSeconds],
    )) as [Array<{ id: string }>, number];
    return count;
  }

  async markDeadLettered(
    manager: EntityManager,
    message: ClaimedOutboxMessage,
    attempts: number,
  ): Promise<number> {
    const [, count] = (await manager.query(
      `UPDATE outbox_messages
       SET attempts = $2, dead_lettered_at = now(), locked_until = NULL, lease_token = NULL
       WHERE id = $1 AND lease_token = $3 AND published_at IS NULL AND dead_lettered_at IS NULL
       RETURNING id`,
      [message.id, attempts, message.lease_token],
    )) as [Array<{ id: string }>, number];
    return count;
  }

  async scheduleRetry(
    manager: EntityManager,
    message: ClaimedOutboxMessage,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<number> {
    const [, count] = (await manager.query(
      `UPDATE outbox_messages
       SET attempts = $2, next_attempt_at = $3, locked_until = NULL, lease_token = NULL
       WHERE id = $1 AND lease_token = $4 AND published_at IS NULL AND dead_lettered_at IS NULL
       RETURNING id`,
      [message.id, attempts, nextAttemptAt, message.lease_token],
    )) as [Array<{ id: string }>, number];
    return count;
  }

  async markPublished(
    manager: EntityManager,
    message: ClaimedOutboxMessage,
  ): Promise<number> {
    const [, count] = (await manager.query(
      `UPDATE outbox_messages
       SET published_at = now(), locked_until = NULL, lease_token = NULL
       WHERE id = $1 AND lease_token = $2 AND published_at IS NULL AND dead_lettered_at IS NULL
       RETURNING id`,
      [message.id, message.lease_token],
    )) as [Array<{ id: string }>, number];
    return count;
  }

  async lag(manager: EntityManager): Promise<number> {
    const [row] = (await manager.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))) * 1000, 0) AS lag
       FROM outbox_messages
       WHERE published_at IS NULL AND dead_lettered_at IS NULL`,
    )) as Array<{ lag: string }>;
    return Number(row.lag);
  }
}
