import { BadRequestException, Body, Controller, Headers, HttpStatus, Post, Res, ServiceUnavailableException, UseGuards, UnprocessableEntityException } from '@nestjs/common';
import type { Response } from 'express';
import { ProviderJwtAuthGuard } from '../../auth/guards/provider-jwt-auth.guard.js';
import { WageringService } from '../services/wagering.service.js';
import { SubmitWagerDto } from '../dtos/submit-wager.dto.js';
import { ApiWageringTransactionResponses } from '../decorators/api-wagering-transaction-responses.decorator.js';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Wagering')
@ApiBearerAuth()
@Controller('wagering/transactions')
@UseGuards(ProviderJwtAuthGuard)
export class WageringController {
  constructor(private readonly wageringService: WageringService) { }

  @Post()
  @ApiOperation({ summary: 'Submit an idempotent wager transaction' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key for the business transaction.',
    example: 'provider-a:transaction-123',
  })
  @ApiHeader({ name: 'X-Correlation-Id', required: false })
  @ApiWageringTransactionResponses()
  async submit(
    @Body() input: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'The Idempotency-Key header is required',
      });
    }

    const result = await this.wageringService.submit(input, idempotencyKey, {
      correlationId,
    });
    if (!result) {
      throw new Error('HTTP submission unexpectedly returned no result');
    }
    if (result.status === 'PENDING_REFERENCE') {
      response.status(HttpStatus.ACCEPTED);
      return result;
    }
    if (result.status === 'REJECTED') {
      throw new UnprocessableEntityException(result);
    }
    if (result.status === 'FAILED') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
