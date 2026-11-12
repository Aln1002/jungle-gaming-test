import { EntityManager } from 'typeorm';
import { WalletLedgerEntryEntity } from '../../../database/entities/wallet-ledger-entry.entity.js';
import { BaseRepository } from '../../../shared/repositories/base.repository.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

export class LedgerRepository extends BaseRepository<WalletLedgerEntryEntity> {
  constructor() {
    super(WalletLedgerEntryEntity);
  }

  findByTransaction(manager: EntityManager, transactionId: string, walletId: string) {
    return this.findOneEntity(manager, { where: { transactionId, walletId } });
  }

  async insert(manager: EntityManager, entry: WalletLedgerEntry, walletVersion: number) {
    if (!entry.isBalanced()) {
      throw new Error('Refusing to persist an unbalanced ledger entry');
    }
    await this.repository(manager).insert({
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion,
      createdAt: entry.createdAt,
    });
  }

  findPage(manager: EntityManager, walletId: string, limit: number, position?: { createdAt: Date; id: string }) {
    const query = this.repository(manager)
      .createQueryBuilder('entry')
      .where('entry.walletId = :walletId', { walletId });
    if (position) {
      query.andWhere(
        '(entry.createdAt < :createdAt OR (entry.createdAt = :createdAt AND entry.id < :id))',
        position,
      );
    }
    return query
      .orderBy('entry.createdAt', 'DESC')
      .addOrderBy('entry.id', 'DESC')
      .take(limit + 1)
      .getMany();
  }
}
