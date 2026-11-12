import { EntityManager } from 'typeorm';
import { WalletEntity } from '../../../database/entities/wallet.entity.js';
import { BaseRepository } from '../../../shared/repositories/base.repository.js';

export class WalletRepository extends BaseRepository<WalletEntity> {
  constructor() {
    super(WalletEntity);
  }

  findById(manager: EntityManager, id: string, lock = false) {
    return this.findOneEntity(manager, {
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
  }

  insert(manager: EntityManager, wallet: Partial<WalletEntity>) {
    return this.repository(manager).insert(wallet);
  }

  save(manager: EntityManager, wallet: WalletEntity) {
    return this.saveEntity(manager, wallet);
  }

  async reconcile(manager: EntityManager, walletId: string) {
    const [snapshot] = (await manager.query(
      `SELECT wallet.balance AS stored_balance, wallet.currency,
              COALESCE(SUM(CASE entry.direction WHEN 'CREDIT' THEN entry.amount ELSE -entry.amount END), 0)::numeric(20, 2) AS calculated_balance,
              COUNT(entry.id)::integer AS entries
       FROM wallets wallet
       LEFT JOIN wallet_ledger_entries entry ON entry.wallet_id = wallet.id
       WHERE wallet.id = $1
       GROUP BY wallet.id`,
      [walletId],
    )) as Array<{
      stored_balance: string;
      calculated_balance: string;
      currency: string;
      entries: number;
    }>;
    return snapshot;
  }
}
