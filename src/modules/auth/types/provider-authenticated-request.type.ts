import type { Request } from 'express';
import { ProviderIdentity } from '../interfaces/provider-identity.interface.js';

export type ProviderAuthenticatedRequest = Request & {
  providerIdentity: ProviderIdentity;
};
