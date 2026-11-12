import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OidcProviderIdentityService } from '../../src/modules/auth/services/provider-identity.service.js';

describe('OIDC provider identity service', () => {
  const audience = 'wagering-api';
  let service: OidcProviderIdentityService;
  let issuerUrl: string;
  let server: ReturnType<typeof createServer>;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = 'test-key';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    issuerUrl = `http://127.0.0.1:${address.port}/realms/wagering`;
    const configService = new ConfigService({
      auth: {
        issuerUrl,
        jwksUrl: `http://127.0.0.1:${address.port}/realms/wagering/protocol/openid-connect/certs`,
        audience,
        providerIdClaim: 'providerId',
      },
    });
    service = new OidcProviderIdentityService(configService);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function createToken(
    claims: Record<string, string>,
    tokenIssuer = issuerUrl,
    tokenAudience = audience,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(tokenIssuer)
      .setAudience(tokenAudience)
      .setSubject('subject-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('accepts a valid token and returns its provider identity', async () => {
    const token = await createToken({ providerId: 'provider-123' });
    expect(service.authenticate(`Bearer ${token}`)).resolves.toEqual({
      providerId: 'provider-123',
      subject: 'subject-123',
    });
  });

  it('rejects missing bearer tokens and invalid provider claims', async () => {
    expect(service.authenticate(undefined)).rejects.toThrow(
      'A bearer token is required',
    );

    const token = await createToken({ providerId: '' });
    expect(service.authenticate(`Bearer ${token}`)).rejects.toThrow(
      'Bearer token is missing provider identity claims',
    );
  });

  it('rejects tokens issued for a different issuer or audience', async () => {
    const wrongIssuer = await createToken(
      { providerId: 'provider-123' },
      'http://issuer.example.test',
    );
    const wrongAudience = await createToken(
      { providerId: 'provider-123' },
      issuerUrl,
      'another-api',
    );
    expect(service.authenticate(`Bearer ${wrongIssuer}`)).rejects.toThrow(
      'Invalid bearer token',
    );

    expect(service.authenticate(`Bearer ${wrongAudience}`)).rejects.toThrow(
      'Invalid bearer token',
    );
  });
});
