import { DeepPartial, EntityManager, EntityTarget, FindOneOptions, ObjectLiteral, Repository } from 'typeorm';

export abstract class BaseRepository<T extends ObjectLiteral> {
  protected constructor(private readonly entity: EntityTarget<T>) { }

  protected repository(manager: EntityManager): Repository<T> {
    return manager.getRepository(this.entity);
  }

  protected createEntity(manager: EntityManager, values: DeepPartial<T>): T {
    return this.repository(manager).create(values);
  }

  protected findOneEntity(manager: EntityManager, options: FindOneOptions<T>) {
    return this.repository(manager).findOne(options);
  }

  protected saveEntity(manager: EntityManager, entity: T) {
    return this.repository(manager).save(entity);
  }
}
