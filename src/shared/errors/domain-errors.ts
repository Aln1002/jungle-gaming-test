import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

export class IdempotencyConflictError extends ConflictException {
  constructor() {
    super({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'The idempotency key was already used with a different payload',
    });
  }
}

export class PermanentMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = getErrorCode(error);
  return (
    code === '40001' ||
    code === '40P01' ||
    code === '55P03' ||
    code?.startsWith('08') === true ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT'
  );
}

export function isDatabaseLockConflict(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === '40P01' || code === '55P03';
}

export function isDatabasePermissionDenied(error: unknown): boolean {
  return error instanceof QueryFailedError && getErrorCode(error) === '42501';
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('driverError' in error)) {
    return false;
  }
  const driverError = error.driverError;
  return (
    typeof driverError === 'object' &&
    driverError !== null &&
    'code' in driverError &&
    driverError.code === '23505'
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const driverError =
    'driverError' in error &&
    error.driverError &&
    typeof error.driverError === 'object'
      ? error.driverError
      : error;
  return 'code' in driverError && typeof driverError.code === 'string'
    ? driverError.code
    : undefined;
}

export function serviceUnavailable(
  message: string,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
    message,
  });
}
