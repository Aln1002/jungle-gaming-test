import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

export function ApiWageringTransactionResponses() {
  return applyDecorators(
    ApiResponse({
      status: 201,
      description: 'Transaction processed or replayed.',
    }),
    ApiResponse({
      status: 202,
      description: 'Waiting for a referenced transaction.',
    }),
    ApiResponse({ status: 400, description: 'Invalid input.' }),
    ApiResponse({ status: 401, description: 'Missing or invalid access token.' }),
    ApiResponse({
      status: 403,
      description: 'Token provider does not match the request.',
    }),
    ApiResponse({
      status: 409,
      description: 'Idempotency or external transaction conflict.',
    }),
    ApiResponse({
      status: 422,
      description: 'Business rule rejected the transaction.',
    }),
    ApiResponse({
      status: 503,
      description: 'Infrastructure or identity provider unavailable.',
    }),
  );
}
