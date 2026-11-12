import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWageringSchema1730000000000 implements MigrationInterface {
  name = 'CreateWageringSchema1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(120) NOT NULL,
        external_transaction_id varchar(200) NOT NULL,
        idempotency_key varchar(255) NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        round_id varchar(200) NOT NULL,
        game_id varchar(200) NOT NULL,
        kind varchar(20) NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        money_amount numeric(20, 2) NOT NULL CHECK (money_amount > 0),
        money_currency varchar(3) NOT NULL CHECK (money_currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(200),
        reference_transaction_id uuid REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        status varchar(30) NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code varchar(60),
        correlation_id varchar(120) NOT NULL,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        result_balance_amount numeric(20, 2) CHECK (result_balance_amount IS NULL OR result_balance_amount >= 0),
        result_balance_currency varchar(3) CHECK (
          result_balance_currency IS NULL OR result_balance_currency ~ '^[A-Z]{3}$'
        ),
        pending_reference_attempts integer NOT NULL DEFAULT 0 CHECK (pending_reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        CONSTRAINT ck_wager_terminal_timestamp CHECK (
          (status IN ('PROCESSED', 'REJECTED', 'FAILED') AND processed_at IS NOT NULL)
          OR (status NOT IN ('PROCESSED', 'REJECTED', 'FAILED') AND processed_at IS NULL)
        ),
        CONSTRAINT ck_wager_processed_result CHECK (
          status <> 'PROCESSED'
          OR (
            result_balance_amount IS NOT NULL
            AND result_balance_currency = money_currency
          )
        ),
        CONSTRAINT ck_wager_failure_code CHECK (
          (status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL)
          OR (status NOT IN ('REJECTED', 'FAILED') AND failure_code IS NULL)
        ),
        CONSTRAINT ck_wager_pending_reference_schedule CHECK (
          (status = 'PENDING_REFERENCE' AND next_reference_attempt_at IS NOT NULL)
          OR (status <> 'PENDING_REFERENCE' AND next_reference_attempt_at IS NULL)
        ),
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK')
          OR (
            reference_external_transaction_id IS NOT NULL
            AND (status <> 'PROCESSED' OR reference_transaction_id IS NOT NULL)
          )
        ),
        CONSTRAINT ck_wager_reference_kind CHECK (
          kind IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NULL
        ),
        CONSTRAINT ck_opening_internal CHECK (
          kind <> 'OPENING' OR (provider_id = 'internal' AND status = 'PROCESSED')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_wager_pending_references
      ON wager_transactions (next_reference_attempt_at, created_at)
      WHERE status = 'PENDING_REFERENCE'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_wager_reference_reversal
      ON wager_transactions (reference_transaction_id, kind)
      WHERE reference_transaction_id IS NOT NULL
        AND kind IN ('REFUND', 'ROLLBACK')
        AND status = 'PROCESSED'
    `);

    await queryRunner.query(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        direction varchar(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL,
        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_ledger_wallet_cursor
      ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(100) NOT NULL,
        message_id varchar(200) NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type varchar(100) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        locked_until timestamptz,
        published_at timestamptz,
        dead_lettered_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_outbox_pending
      ON outbox_messages (next_attempt_at, occurred_at)
      WHERE published_at IS NULL AND dead_lettered_at IS NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION enforce_wager_transaction_state() RETURNS trigger AS $$
      BEGIN
        IF ROW(
          NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
          NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id,
          NEW.game_id, NEW.kind, NEW.money_amount, NEW.money_currency,
          NEW.reference_external_transaction_id, NEW.correlation_id, NEW.created_at
        ) IS DISTINCT FROM ROW(
          OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
          OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id,
          OLD.game_id, OLD.kind, OLD.money_amount, OLD.money_currency,
          OLD.reference_external_transaction_id, OLD.correlation_id, OLD.created_at
        ) THEN
          RAISE EXCEPTION 'wager transaction business fields are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          IF ROW(
            NEW.status, NEW.reference_transaction_id, NEW.failure_code,
            NEW.processed_at, NEW.result_balance_amount, NEW.result_balance_currency,
            NEW.pending_reference_attempts
          ) IS DISTINCT FROM ROW(
            OLD.status, OLD.reference_transaction_id, OLD.failure_code,
            OLD.processed_at, OLD.result_balance_amount, OLD.result_balance_currency,
            OLD.pending_reference_attempts
          ) THEN
            RAISE EXCEPTION 'terminal wager transactions are immutable'
              USING ERRCODE = '55000';
          END IF;
        ELSIF OLD.status = 'PENDING_REFERENCE'
          AND NEW.status NOT IN ('PENDING_REFERENCE', 'PENDING', 'REJECTED', 'FAILED', 'PROCESSED') THEN
          RAISE EXCEPTION 'invalid pending-reference transaction transition'
            USING ERRCODE = '23514';
        ELSIF OLD.status = 'PENDING'
          AND NEW.status NOT IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'invalid pending transaction transition'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_wager_transaction_state
      BEFORE UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION enforce_wager_transaction_state()
    `);

    await queryRunner.query(`
      CREATE FUNCTION validate_wager_reference() RETURNS trigger AS $$
      DECLARE
        referenced wager_transactions%ROWTYPE;
      BEGIN
        IF NEW.status <> 'PROCESSED' OR NEW.kind NOT IN ('REFUND', 'ROLLBACK') THEN
          RETURN NEW;
        END IF;
        SELECT * INTO referenced
        FROM wager_transactions
        WHERE id = NEW.reference_transaction_id
        FOR KEY SHARE;
        IF NOT FOUND
          OR referenced.status <> 'PROCESSED'
          OR referenced.provider_id <> NEW.provider_id
          OR referenced.player_id <> NEW.player_id
          OR referenced.wallet_id <> NEW.wallet_id
          OR referenced.money_currency <> NEW.money_currency
          OR referenced.money_amount <> NEW.money_amount
          OR referenced.round_id <> NEW.round_id
          OR referenced.external_transaction_id <> NEW.reference_external_transaction_id
          OR (NEW.kind = 'REFUND' AND referenced.kind <> 'BET')
          OR (
            NEW.kind = 'ROLLBACK'
            AND referenced.kind NOT IN ('BET', 'WIN', 'REFUND')
          ) THEN
          RAISE EXCEPTION 'wager reference violates transaction invariants'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_validate_wager_reference
      BEFORE INSERT OR UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION validate_wager_reference()
    `);

    await queryRunner.query(`
      CREATE FUNCTION assert_wager_ledger_entries() RETURNS trigger AS $$
      DECLARE
        current_kind varchar(20);
        current_status varchar(30);
        ledger_count bigint;
        expected_count bigint;
      BEGIN
        SELECT kind, status INTO current_kind, current_status
        FROM wager_transactions WHERE id = NEW.id;
        SELECT COUNT(*) INTO ledger_count
        FROM wallet_ledger_entries WHERE transaction_id = NEW.id;
        IF current_status = 'PROCESSED'
          AND current_kind NOT IN ('LOSS') THEN
          expected_count := 1;
        ELSE
          expected_count := 0;
        END IF;
        IF ledger_count <> expected_count THEN
          RAISE EXCEPTION 'wager transaction has an invalid number of ledger entries'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_wager_ledger_entries
      AFTER INSERT OR UPDATE ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wager_ledger_entries()
    `);

    await queryRunner.query(`
      CREATE FUNCTION enforce_inbox_immutability() RETURNS trigger AS $$
      BEGIN
        IF ROW(NEW.consumer_name, NEW.message_id, NEW.payload_hash, NEW.received_at)
          IS DISTINCT FROM ROW(OLD.consumer_name, OLD.message_id, OLD.payload_hash, OLD.received_at)
          OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at) THEN
          RAISE EXCEPTION 'inbox message identity and processing state are immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_inbox_immutable
      BEFORE UPDATE OR DELETE ON inbox_messages
      FOR EACH ROW EXECUTE FUNCTION enforce_inbox_immutability()
    `);

    await queryRunner.query(`
      CREATE FUNCTION enforce_wallet_version() RETURNS trigger AS $$
      BEGIN
        IF ROW(NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity and currency are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet version must increment with balance changes'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet version may only change with balance'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_wallet_version
      BEFORE UPDATE ON wallets
      FOR EACH ROW EXECUTE FUNCTION enforce_wallet_version()
    `);

    await queryRunner.query(`
      CREATE FUNCTION reject_financial_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'financial records cannot be deleted'
          USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_wallet_no_delete
      BEFORE DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION reject_financial_delete()
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_wager_transaction_no_delete
      BEFORE DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION reject_financial_delete()
    `);

    await queryRunner.query(`
      CREATE FUNCTION enforce_ledger_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable'
          USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION enforce_ledger_append_only()
    `);

    await queryRunner.query(`
      CREATE FUNCTION validate_ledger_entry() RETURNS trigger AS $$
      DECLARE
        transaction_wallet uuid;
        transaction_status varchar(30);
        transaction_kind varchar(20);
        transaction_amount numeric(20, 2);
        transaction_currency varchar(3);
        transaction_reference_id uuid;
        wallet_balance numeric(20, 2);
        wallet_currency varchar(3);
        wallet_version_value integer;
        referenced_direction varchar(10);
      BEGIN
        SELECT wallet_id, status, kind, money_amount, money_currency, reference_transaction_id
        INTO transaction_wallet, transaction_status, transaction_kind, transaction_amount,
          transaction_currency, transaction_reference_id
        FROM wager_transactions WHERE id = NEW.transaction_id;
        SELECT balance, currency, version
        INTO wallet_balance, wallet_currency, wallet_version_value
        FROM wallets WHERE id = NEW.wallet_id;
        IF transaction_wallet IS DISTINCT FROM NEW.wallet_id
          OR transaction_status IS DISTINCT FROM 'PROCESSED'
          OR transaction_amount IS DISTINCT FROM NEW.amount
          OR transaction_currency IS DISTINCT FROM NEW.currency
          OR wallet_currency IS DISTINCT FROM NEW.currency
          OR wallet_balance IS DISTINCT FROM NEW.balance_after
          OR wallet_version_value IS DISTINCT FROM NEW.wallet_version THEN
          RAISE EXCEPTION 'ledger entry does not match processed transaction and wallet'
            USING ERRCODE = '23514';
        END IF;
        IF (transaction_kind IN ('OPENING', 'WIN', 'REFUND') AND NEW.direction <> 'CREDIT')
          OR (transaction_kind = 'BET' AND NEW.direction <> 'DEBIT')
          OR transaction_kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger direction does not match wager transaction kind'
            USING ERRCODE = '23514';
        END IF;
        IF transaction_kind = 'ROLLBACK' THEN
          SELECT direction INTO referenced_direction
          FROM wallet_ledger_entries
          WHERE transaction_id = transaction_reference_id AND wallet_id = NEW.wallet_id;
          IF referenced_direction IS NULL
            OR NEW.direction = referenced_direction THEN
            RAISE EXCEPTION 'rollback ledger direction does not reverse its reference'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_validate_ledger_entry
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION validate_ledger_entry()
    `);

    await queryRunner.query(`
      CREATE FUNCTION assert_wallet_ledger_consistency() RETURNS trigger AS $$
      DECLARE
        target_wallet_id uuid;
        stored_balance numeric(20, 2);
        ledger_balance numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_wallet_id := NEW.id;
        ELSE
          target_wallet_id := NEW.wallet_id;
        END IF;
        SELECT balance INTO stored_balance FROM wallets WHERE id = target_wallet_id;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        SELECT COALESCE(SUM(
          CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
        ), 0) INTO ledger_balance
        FROM wallet_ledger_entries WHERE wallet_id = target_wallet_id;
        IF stored_balance IS DISTINCT FROM ledger_balance THEN
          RAISE EXCEPTION 'wallet balance does not match immutable ledger'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_wallet_ledger_consistency
      AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_consistency()
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_ledger_wallet_consistency
      AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_consistency()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_messages');
    await queryRunner.query('DROP TABLE inbox_messages');
    await queryRunner.query('DROP TABLE wallet_ledger_entries');
    await queryRunner.query('DROP TABLE wager_transactions');
    await queryRunner.query('DROP TABLE wallets');
    await queryRunner.query('DROP FUNCTION assert_wallet_ledger_consistency()');
    await queryRunner.query('DROP FUNCTION assert_wager_ledger_entries()');
    await queryRunner.query('DROP FUNCTION validate_ledger_entry()');
    await queryRunner.query('DROP FUNCTION enforce_ledger_append_only()');
    await queryRunner.query('DROP FUNCTION enforce_wallet_version()');
    await queryRunner.query('DROP FUNCTION reject_financial_delete()');
    await queryRunner.query('DROP FUNCTION enforce_inbox_immutability()');
    await queryRunner.query('DROP FUNCTION enforce_wager_transaction_state()');
    await queryRunner.query('DROP FUNCTION validate_wager_reference()');
  }
}
