import { Type } from 'class-transformer';
import { IsDefined, IsObject, IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../shared/dtos/money.dto.js';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWalletDto {
  @ApiProperty({
    format: 'uuid',
    example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
