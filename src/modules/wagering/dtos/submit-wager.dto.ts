import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../shared/dtos/money.dto.js';
import { WagerTransactionKindEnum } from '../enums/wager-transaction-kind.enum.js';
import type { ExternalWagerTransactionKind } from '../interfaces/external-wager-transaction-kind.interface.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitWagerDto {
  @ApiProperty({ example: 'provider-a', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @Length(1, 120)
  providerId!: string;

  @ApiProperty({ example: 'transaction-123', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  externalTransactionId!: string;

  @ApiProperty({
    format: 'uuid',
    example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  })
  @IsUUID()
  playerId!: string;

  @ApiProperty({
    format: 'uuid',
    example: '0192f291-27dd-7d3f-8071-5f8685deef37',
  })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: 'round-987', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  gameId!: string;

  @ApiProperty({
    enum: [
      WagerTransactionKindEnum.Bet,
      WagerTransactionKindEnum.Win,
      WagerTransactionKindEnum.Loss,
      WagerTransactionKindEnum.Refund,
      WagerTransactionKindEnum.Rollback,
    ],
    example: WagerTransactionKindEnum.Bet,
  })
  @IsIn([
    WagerTransactionKindEnum.Bet,
    WagerTransactionKindEnum.Win,
    WagerTransactionKindEnum.Loss,
    WagerTransactionKindEnum.Refund,
    WagerTransactionKindEnum.Rollback,
  ])
  kind!: ExternalWagerTransactionKind;

  @ApiProperty({ type: MoneyDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({
    description:
      'Required for REFUND and ROLLBACK; optional for WIN and not accepted for other kinds.',
    example: 'transaction-123',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  referenceExternalTransactionId?: string;
}
