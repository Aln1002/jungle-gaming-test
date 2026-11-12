import { ProviderIdentity } from "../interfaces/provider-identity.interface.js";

export abstract class ProviderIdentityPort {
  abstract authenticate(
    authorizationHeader: string | undefined,
  ): Promise<ProviderIdentity>;
}
