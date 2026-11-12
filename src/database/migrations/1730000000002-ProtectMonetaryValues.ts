import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProtectMonetaryValues1730000000002 implements MigrationInterface {
  name = 'ProtectMonetaryValues1730000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallets ADD CONSTRAINT ck_wallet_balance_finite
        CHECK (balance <> 'NaN'::numeric);
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_money_finite
        CHECK (money_amount <> 'NaN'::numeric AND
          (result_balance_amount IS NULL OR result_balance_amount <> 'NaN'::numeric));
      ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_ledger_money_finite
        CHECK (amount <> 'NaN'::numeric AND balance_before <> 'NaN'::numeric
          AND balance_after <> 'NaN'::numeric);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries DROP CONSTRAINT ck_ledger_money_finite;
      ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_money_finite;
      ALTER TABLE wallets DROP CONSTRAINT ck_wallet_balance_finite;
    `);
  }
}
