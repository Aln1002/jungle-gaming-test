import { MigrationInterface, QueryRunner } from 'typeorm';

export class PreventCrossTypeReversals1730000000001 implements MigrationInterface {
  name = 'PreventCrossTypeReversals1730000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION prevent_cross_type_reversal() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'PROCESSED'
          AND NEW.kind IN ('REFUND', 'ROLLBACK')
          AND NEW.reference_transaction_id IS NOT NULL THEN
          PERFORM id FROM wager_transactions
            WHERE id = NEW.reference_transaction_id FOR UPDATE;
          IF EXISTS (
            SELECT 1 FROM wager_transactions
            WHERE reference_transaction_id = NEW.reference_transaction_id
              AND status = 'PROCESSED'
              AND kind IN ('REFUND', 'ROLLBACK')
              AND id <> NEW.id
          ) THEN
            RAISE EXCEPTION 'referenced transaction already reversed'
              USING ERRCODE = '23505', CONSTRAINT = 'uq_wager_reference_any_reversal';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_prevent_cross_type_reversal
      BEFORE INSERT OR UPDATE OF status, reference_transaction_id, kind
      ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION prevent_cross_type_reversal()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER trg_prevent_cross_type_reversal ON wager_transactions',
    );
    await queryRunner.query('DROP FUNCTION prevent_cross_type_reversal()');
  }
}
