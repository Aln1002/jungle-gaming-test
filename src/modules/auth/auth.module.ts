import { Module } from '@nestjs/common';
import { ProviderJwtAuthGuard } from './guards/provider-jwt-auth.guard.js';
import { OidcProviderIdentityService } from './services/provider-identity.service.js';
import { ProviderIdentityPort } from './ports/provider-identity.port.js';

@Module({
  providers: [
    ProviderJwtAuthGuard,
    OidcProviderIdentityService,
    {
      provide: ProviderIdentityPort,
      useExisting: OidcProviderIdentityService,
    },
  ],
  exports: [ProviderJwtAuthGuard, ProviderIdentityPort],
})
export class AuthModule {}
