import { expect } from 'bun:test';
import type { DataSource } from 'typeorm';

export async function expectAllWalletsReconciled(
  source: DataSource,
): Promise<void> {
  const [result] = (await source.query(
    `SELECT count(*)::int AS mismatches
     FROM wallets w
     WHERE w.balance IS DISTINCT FROM (
       SELECT COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
       FROM wallet_ledger_entries l WHERE l.wallet_id = w.id
     )`,
  )) as Array<{ mismatches: number }>;
  expect(result.mismatches).toBe(0);
}
