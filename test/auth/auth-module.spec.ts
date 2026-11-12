import { describe, expect, it } from 'bun:test';
import { Controller, Module, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { ProviderJwtAuthGuard } from '../../src/modules/auth/guards/provider-jwt-auth.guard.js';

@Controller()
@UseGuards(ProviderJwtAuthGuard)
class ProtectedController {}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [
        () => ({
          auth: {
            issuerUrl: 'http://localhost:8080/realms/wagering',
            jwksUrl: 'http://localhost:8080/realms/wagering/certs',
            audience: 'wagering-api',
            providerIdClaim: 'providerId',
          },
        }),
      ],
    }),
    AuthModule,
  ],
  controllers: [ProtectedController],
})
class ProtectedFeatureModule {}

describe('AuthModule', () => {
  it('resolves the guard in a module that imports AuthModule', async () => {
    const app = await NestFactory.createApplicationContext(
      ProtectedFeatureModule,
      { logger: false, abortOnError: false },
    );
    try {
      expect(app.get(ProviderJwtAuthGuard)).toBeInstanceOf(
        ProviderJwtAuthGuard,
      );
    } finally {
      await app.close();
    }
  });
});
