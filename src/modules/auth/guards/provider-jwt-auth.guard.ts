import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { ProviderAuthenticatedRequest } from '../types/provider-authenticated-request.type.js';
import { ProviderIdentityPort } from '../ports/provider-identity.port.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class ProviderJwtAuthGuard implements CanActivate {
  constructor(private readonly identity: ProviderIdentityPort) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ProviderAuthenticatedRequest>();
    const providerIdentity = await this.identity.authenticate(
      request.get('authorization'),
    );
    const requestedProviderId = this.getRequestedProviderId(request);

    if (
      requestedProviderId !== undefined &&
      requestedProviderId !== providerIdentity.providerId
    ) {
      throw new ForbiddenException('Provider identity does not match request');
    }

    request.providerIdentity = providerIdentity;
    return true;
  }

  private getRequestedProviderId(request: Request): string | undefined {
    if (
      isRecord(request.params) &&
      typeof request.params.providerId === 'string'
    ) {
      return request.params.providerId;
    }
    if (isRecord(request.body) && typeof request.body.providerId === 'string') {
      return request.body.providerId;
    }
    return undefined;
  }
}
