import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryColumn({ name: 'consumer_name', type: 'varchar', length: 100 })
  consumerName!: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 200 })
  messageId!: string;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;
}
