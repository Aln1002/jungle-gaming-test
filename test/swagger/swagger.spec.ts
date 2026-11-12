import { describe, expect, it } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProviderIdentityPort } from '../../src/modules/auth/ports/provider-identity.port.js';
import { WalletsController } from '../../src/modules/wallets/controllers/wallets.controller.js';
import { WageringController } from '../../src/modules/wagering/controllers/wagering.controller.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import { WalletService } from '../../src/modules/wallets/services/wallet.service.js';
import { setupSwagger } from '../../src/shared/swagger/swagger.config.js';

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: WageringService, useValue: {} },
    { provide: WalletService, useValue: {} },
    { provide: ProviderIdentityPort, useValue: {} },
  ],
})
class SwaggerTestModule {}

describe('Swagger documentation', () => {
  it('serves dark-themed docs with DTO schemas, bearer auth and idempotency header', async () => {
    const app = await NestFactory.create(SwaggerTestModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      setupSwagger(app);
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const ui = await fetch(`${base}/docs/`);
      expect(ui.status).toBe(200);
      const html = await ui.text();
      expect(html).toContain('#111827');
      expect(html).toContain('Wagering API Docs');

      const result = await fetch(`${base}/docs-json`);
      expect(result.status).toBe(200);
      const document = (await result.json()) as {
        paths: Record<
          string,
          Record<
            string,
            {
              security?: unknown[];
              parameters?: { name: string; required: boolean }[];
              responses?: Record<string, { description: string }>;
            }
          >
        >;
        components: {
          schemas: Record<string, { properties: Record<string, unknown> }>;
        };
      };
      const operation = document.paths['/wagering/transactions'].post;
      expect(operation.security).toEqual([{ bearer: [] }]);
      expect(operation.parameters).toContainEqual(
        expect.objectContaining({ name: 'Idempotency-Key', required: true }),
      );
      expect(
        document.components.schemas.SubmitWagerDto.properties.money,
      ).toBeDefined();
      expect(
        document.components.schemas.MoneyDto.properties.amount,
      ).toBeDefined();
      expect(Object.keys(operation.responses ?? {}).sort()).toEqual([
        '201',
        '202',
        '400',
        '401',
        '403',
        '409',
        '422',
        '503',
      ]);
      expect(document.paths['/wallets'].post.security).toEqual([
        { bearer: [] },
      ]);
    } finally {
      await app.close();
    }
  });
});
