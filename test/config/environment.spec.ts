import { describe, expect, it } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import {
  configuration,
  getEnvironment,
  getEnvironmentFilePaths,
} from '../../config/env/configuration.js';
import { EnvironmentGlobalsEnum } from '../../src/shared/enums/environment-globals.enum.js';

describe('runtime environment configuration', () => {
  it('loads environment-specific files in priority order', () => {
    expect(getEnvironmentFilePaths({ NODE_ENV: 'development' })).toEqual([
      join(process.cwd(), 'config', 'env', 'development.env'),
      '.env',
    ]);
    for (const [environment, suffix] of [
      ['test', 'test'],
      ['production', 'prod'],
    ] as const) {
      expect(getEnvironmentFilePaths({ NODE_ENV: environment })).toEqual([
        join(process.cwd(), 'config', 'env', `env.${suffix}`),
        join(process.cwd(), 'config', 'env', `${environment}.env`),
        '.env',
      ]);
    }
  });

  it('uses development defaults and derives local queue URLs', () => {
    const config = getEnvironment({ NODE_ENV: 'development' });

    expect(config.app.port).toBe(3000);
    expect(config.database.url).toContain('localhost:5433/wagering');
    expect(config.sqs.endpoint).toBe('http://localhost:4566');
    expect(config.sqs.transactionQueueUrl).toBe(
      'http://localhost:4566/000000000000/wager-transactions.fifo',
    );
    expect(config.workers.pendingReferencePollIntervalMs).toBe(1000);
    expect(config.workers.maxPendingReferenceAttempts).toBe(8);
    expect(config.workers.maxDatabaseAttempts).toBe(3);
  });

  it('exposes parsed settings through Nest ConfigService keys', () => {
    const configService = new ConfigService(
      configuration({ NODE_ENV: 'development' }),
    );

    expect(configService.getOrThrow<number>(EnvironmentGlobalsEnum.Port)).toBe(
      3000,
    );
    expect(
      configService.getOrThrow<string>(EnvironmentGlobalsEnum.DatabaseUrl),
    ).toContain('localhost:5433/wagering');
  });

  it('uses explicitly configured service endpoints and numeric settings', () => {
    const config = getEnvironment({
      NODE_ENV: 'test',
      PORT: '3100',
      DATABASE_URL: 'postgresql://localhost/custom',
      SQS_ENDPOINT: 'https://sqs.example.test/',
      SQS_ACCOUNT_ID: '123456789012',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '2500',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '60',
      MAX_PENDING_REFERENCE_ATTEMPTS: '4',
      MAX_DATABASE_ATTEMPTS: '2',
    });

    expect(config.app.port).toBe(3100);
    expect(config.database.url).toBe('postgresql://localhost/custom');
    expect(config.sqs.endpoint).toBe('https://sqs.example.test');
    expect(config.sqs.transactionQueueUrl).toBe(
      'https://sqs.example.test/123456789012/wager-transactions.fifo',
    );
    expect(config.sqs.visibilityTimeoutSeconds).toBe(60);
    expect(config.workers.pendingReferencePollIntervalMs).toBe(2500);
    expect(config.workers.maxPendingReferenceAttempts).toBe(4);
    expect(config.workers.maxDatabaseAttempts).toBe(2);
  });

  it('rejects invalid environment values before the application starts', () => {
    expect(() => getEnvironment({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL is required in production',
    );
    expect(() =>
      getEnvironment({ NODE_ENV: 'test', PORT: 'not-a-port' }),
    ).toThrow('PORT must be an integer');
    expect(() =>
      getEnvironment({ NODE_ENV: 'test', SQS_ENDPOINT: 'ftp://invalid.test' }),
    ).toThrow('SQS_ENDPOINT must be a valid HTTP or HTTPS URL');
    expect(() =>
      getEnvironment({
        NODE_ENV: 'test',
        SQS_TRANSACTION_QUEUE_URL: 'ftp://invalid.test',
      }),
    ).toThrow('SQS_TRANSACTION_QUEUE_URL must be a valid HTTP or HTTPS URL');
    expect(() =>
      getEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'http://invalid.test' }),
    ).toThrow('DATABASE_URL must be a valid PostgreSQL URL');
    for (const value of ['0', '101', '1.5', 'not-a-number']) {
      expect(() =>
        getEnvironment({
          NODE_ENV: 'test',
          MAX_PENDING_REFERENCE_ATTEMPTS: value,
        }),
      ).toThrow('MAX_PENDING_REFERENCE_ATTEMPTS must be an integer');
    }
    for (const value of ['0', '11', '1.5', 'not-a-number']) {
      expect(() =>
        getEnvironment({ NODE_ENV: 'test', MAX_DATABASE_ATTEMPTS: value }),
      ).toThrow('MAX_DATABASE_ATTEMPTS must be an integer');
    }
  });
});
