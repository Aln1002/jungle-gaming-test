import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wallets' })
export class WalletEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'numeric', precision: 20, scale: 2 })
  balance!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
