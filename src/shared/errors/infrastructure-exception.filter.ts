import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { isTransientDatabaseError, serviceUnavailable } from './domain-errors.js';

@Catch()
export class InfrastructureExceptionFilter extends BaseExceptionFilter {
  constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (isTransientDatabaseError(exception)) {
      super.catch(
        serviceUnavailable(
          'A required infrastructure dependency is temporarily unavailable',
        ),
        host,
      );
      return;
    }
    super.catch(exception, host);
  }
}
