import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import { EnvironmentGlobalsEnum } from '../../../shared/enums/environment-globals.enum.js';
import { ProviderIdentityPort } from '../ports/provider-identity.port.js';

const invalidTokenErrors = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JOSEAlgNotAllowed,
];

@Injectable()
export class OidcProviderIdentityService extends ProviderIdentityPort {
  private readonly issuerUrl: string;
  private readonly audience: string;
  private readonly providerIdClaim: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(configService: ConfigService) {
    super();
    this.issuerUrl = configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.OidcIssuerUrl,
    );
    this.audience = configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.OidcAudience,
    );
    this.providerIdClaim = configService.getOrThrow<string>(
      EnvironmentGlobalsEnum.OidcProviderIdClaim,
    );
    this.jwks = createRemoteJWKSet(
      new URL(
        configService.getOrThrow<string>(EnvironmentGlobalsEnum.OidcJwksUrl),
      ),
    );
  }

  async authenticate(authorizationHeader: string | undefined): Promise<{ providerId: string; subject: string }> {
    const token = this.getBearerToken(authorizationHeader);
    let payload: JWTPayload;

    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuerUrl,
        audience: this.audience,
        algorithms: ['RS256'],
      }));
    } catch (error) {
      if (
        error instanceof Error &&
        invalidTokenErrors.some((errorType) => error instanceof errorType)
      ) {
        throw new UnauthorizedException('Invalid bearer token');
      }
      if (error instanceof errors.JOSEError) {
        throw new ServiceUnavailableException(
          'Identity provider is temporarily unavailable',
        );
      }
      throw error;
    }

    const providerId = payload[this.providerIdClaim];
    if (
      typeof providerId !== 'string' ||
      providerId.trim() === '' ||
      typeof payload.sub !== 'string' ||
      payload.sub.trim() === ''
    ) {
      throw new UnauthorizedException(
        'Bearer token is missing provider identity claims',
      );
    }

    return { providerId, subject: payload.sub };
  }

  private getBearerToken(authorizationHeader: string | undefined): string {
    const match = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      throw new UnauthorizedException('A bearer token is required');
    }
    return match[1];
  }
}
