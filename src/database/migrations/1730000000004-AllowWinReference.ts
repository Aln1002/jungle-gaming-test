import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowWinReference1730000000004 implements MigrationInterface {
  name = 'AllowWinReference1730000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_reference_kind;
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_reference_kind
        CHECK (kind IN ('WIN', 'REFUND', 'ROLLBACK') OR reference_transaction_id IS NULL);
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_win_reference_complete
        CHECK (kind <> 'WIN' OR status <> 'PROCESSED'
          OR ((reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL)));
      CREATE FUNCTION validate_win_reference() RETURNS trigger AS $$
      DECLARE referenced wager_transactions%ROWTYPE;
      BEGIN
        IF NEW.kind <> 'WIN' OR NEW.status <> 'PROCESSED' OR NEW.reference_transaction_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT * INTO referenced FROM wager_transactions
          WHERE id = NEW.reference_transaction_id FOR KEY SHARE;
        IF NOT FOUND OR referenced.kind <> 'BET' OR referenced.status <> 'PROCESSED'
          OR referenced.provider_id <> NEW.provider_id
          OR referenced.external_transaction_id <> NEW.reference_external_transaction_id
          OR referenced.wallet_id <> NEW.wallet_id OR referenced.player_id <> NEW.player_id
          OR referenced.money_currency <> NEW.money_currency OR referenced.round_id <> NEW.round_id THEN
          RAISE EXCEPTION 'win reference violates transaction invariants' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_validate_win_reference
        BEFORE INSERT OR UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION validate_win_reference();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER trg_validate_win_reference ON wager_transactions;
      DROP FUNCTION validate_win_reference();
      ALTER TABLE wager_transactions DROP CONSTRAINT ck_win_reference_complete;
      ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_reference_kind;
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_reference_kind
        CHECK (kind IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NULL);
    `);
  }
}
