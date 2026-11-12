import { DeepPartial, EntityManager, FindManyOptions, FindOneOptions } from 'typeorm';
import { WagerTransactionEntity } from '../../../database/entities/wager-transaction.entity.js';
import { BaseRepository } from '../../../shared/repositories/base.repository.js';

export class WagerTransactionRepository extends BaseRepository<WagerTransactionEntity> {
  constructor() {
    super(WagerTransactionEntity);
  }

  create(manager: EntityManager, values: DeepPartial<WagerTransactionEntity>) {
    return this.createEntity(manager, values);
  }
  insert(manager: EntityManager, entity: WagerTransactionEntity) {
    return this.repository(manager).insert(entity);
  }
  save(manager: EntityManager, entity: WagerTransactionEntity) {
    return this.saveEntity(manager, entity);
  }
  findOne(manager: EntityManager, options: FindOneOptions<WagerTransactionEntity>) {
    return this.findOneEntity(manager, options);
  }
  find(manager: EntityManager, options: FindManyOptions<WagerTransactionEntity>) {
    return this.repository(manager).find(options);
  }
}
