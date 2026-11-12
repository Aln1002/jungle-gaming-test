import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import type { ProviderAuthenticatedRequest } from '../../auth/types/provider-authenticated-request.type.js';
import { ProviderJwtAuthGuard } from '../../auth/guards/provider-jwt-auth.guard.js';
import { WageringService } from '../services/wagering.service.js';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Wagering')
@ApiBearerAuth()
@Controller()
@UseGuards(ProviderJwtAuthGuard)
export class TransactionQueriesController {
  constructor(private readonly wageringService: WageringService) { }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({
    summary: 'Get a transaction belonging to the authenticated provider',
  })
  getById(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Req() request: ProviderAuthenticatedRequest,
  ) {
    return this.wageringService.getTransaction(
      transactionId,
      request.providerIdentity.providerId,
    );
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({
    summary: 'Get a transaction by provider and external transaction ID',
  })
  getByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.wageringService.getProviderTransaction(
      providerId,
      externalTransactionId,
    );
  }
}
