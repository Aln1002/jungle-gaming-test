import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxLeaseToken1730000000003 implements MigrationInterface {
  name = 'AddOutboxLeaseToken1730000000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE outbox_messages ADD COLUMN lease_token uuid',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE outbox_messages DROP COLUMN lease_token',
    );
  }
}
