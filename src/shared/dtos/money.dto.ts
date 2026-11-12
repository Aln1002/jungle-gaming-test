import { IsIn, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SUPPORTED_CURRENCIES } from '../../modules/wallets/domain/money.js';

export class MoneyDto {
  @ApiProperty({ example: '25.00', pattern: '^(0|[1-9]\\d{0,17})\\.\\d{2}$' })
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/, {
    message:
      'amount must have at most 18 integer digits and exactly two decimal places',
  })
  amount!: string;

  @ApiProperty({ example: 'BRL', pattern: '^[A-Z]{3}$' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be an uppercase ISO-4217 code',
  })
  @IsIn(SUPPORTED_CURRENCIES, {
    message: 'currency must be a supported ISO-4217 code',
  })
  currency!: string;
}
