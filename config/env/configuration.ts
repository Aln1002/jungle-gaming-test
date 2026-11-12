import { join } from 'node:path';
import { parseHttpUrlSetting, parseIntegerSetting, parsePostgresUrlSetting, } from '../../src/shared/utils/validation.util.js';

export type NodeEnvironment = 'development' | 'test' | 'production';

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  const environment = value ?? 'development';
  if (
    environment !== 'development' &&
    environment !== 'test' &&
    environment !== 'production'
  ) {
    throw new Error('NODE_ENV must be one of: development, test, production');
  }
  return environment;
}

export function getEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const nodeEnvironment = parseNodeEnvironment(source.NODE_ENV);
  const isLocal = nodeEnvironment !== 'production';
  const databaseUrl = parsePostgresUrlSetting(
    'DATABASE_URL',
    source.DATABASE_URL,
  );
  const databasePort = parseIntegerSetting(
    'DB_PORT',
    source.DB_PORT,
    5433,
    1,
    65535,
  );
  const sqsEndpoint = parseHttpUrlSetting(
    'SQS_ENDPOINT',
    source.SQS_ENDPOINT,
    isLocal ? 'http://localhost:4566' : undefined,
  );
  const sqsAccountId = source.SQS_ACCOUNT_ID ?? '000000000000';
  const oidcIssuerUrl = parseHttpUrlSetting(
    'OIDC_ISSUER_URL',
    source.OIDC_ISSUER_URL,
  );
  const oidcJwksUrl = parseHttpUrlSetting(
    'OIDC_JWKS_URL',
    source.OIDC_JWKS_URL,
  );
  const oidcAudience = source.OIDC_AUDIENCE?.trim();
  const oidcProviderIdClaim =
    source.OIDC_PROVIDER_ID_CLAIM?.trim() || 'providerId';
  const transactionQueueUrl = parseHttpUrlSetting(
    'SQS_TRANSACTION_QUEUE_URL',
    source.SQS_TRANSACTION_QUEUE_URL,
    sqsEndpoint
      ? `${sqsEndpoint}/${sqsAccountId}/wager-transactions.fifo`
      : undefined,
  );
  const transactionDlqUrl = parseHttpUrlSetting(
    'SQS_TRANSACTION_DLQ_URL',
    source.SQS_TRANSACTION_DLQ_URL,
    sqsEndpoint
      ? `${sqsEndpoint}/${sqsAccountId}/wager-transactions-dlq.fifo`
      : undefined,
  );
  const eventQueueUrl = parseHttpUrlSetting(
    'SQS_EVENT_QUEUE_URL',
    source.SQS_EVENT_QUEUE_URL,
    sqsEndpoint
      ? `${sqsEndpoint}/${sqsAccountId}/wager-events.fifo`
      : undefined,
  );
  const eventDlqUrl = parseHttpUrlSetting(
    'SQS_EVENT_DLQ_URL',
    source.SQS_EVENT_DLQ_URL,
    sqsEndpoint
      ? `${sqsEndpoint}/${sqsAccountId}/wager-events-dlq.fifo`
      : undefined,
  );

  if (nodeEnvironment === 'production' && !databaseUrl) {
    throw new Error('DATABASE_URL is required in production');
  }
  if (nodeEnvironment === 'production') {
    if (!oidcIssuerUrl || !oidcJwksUrl || !oidcAudience) {
      throw new Error(
        'OIDC_ISSUER_URL, OIDC_JWKS_URL, and OIDC_AUDIENCE are required in production',
      );
    }
  }

  return Object.freeze({
    nodeEnvironment,
    app: {
      port: parseIntegerSetting('PORT', source.PORT, 3000, 1, 65535),
    },
    database: {
      url:
        databaseUrl ??
        `postgresql://${source.DB_USER ?? 'postgres'}:${source.DB_PASSWORD ?? 'postgres'}@${source.DB_HOST ?? 'localhost'}:${databasePort}/${source.DB_NAME ?? 'wagering'}`,
      ssl: source.DB_SSL === 'true',
    },
    auth: {
      issuerUrl: oidcIssuerUrl,
      jwksUrl: oidcJwksUrl,
      audience: oidcAudience,
      providerIdClaim: oidcProviderIdClaim,
    },
    sqs: {
      endpoint: sqsEndpoint,
      region: source.AWS_REGION ?? 'us-east-1',
      accountId: sqsAccountId,
      transactionQueueUrl: transactionQueueUrl ?? '',
      transactionDlqUrl: transactionDlqUrl ?? '',
      eventQueueUrl: eventQueueUrl ?? '',
      eventDlqUrl: eventDlqUrl ?? '',
      localAccessKeyId: source.AWS_ACCESS_KEY_ID ?? 'test',
      localSecretAccessKey: source.AWS_SECRET_ACCESS_KEY ?? 'test',
      visibilityTimeoutSeconds: parseIntegerSetting(
        'SQS_VISIBILITY_TIMEOUT_SECONDS',
        source.SQS_VISIBILITY_TIMEOUT_SECONDS,
        30,
        1,
        43200,
      ),
    },
    workers: {
      maxPendingReferenceAttempts: parseIntegerSetting(
        'MAX_PENDING_REFERENCE_ATTEMPTS',
        source.MAX_PENDING_REFERENCE_ATTEMPTS,
        8,
        1,
        100,
      ),
      maxDatabaseAttempts: parseIntegerSetting(
        'MAX_DATABASE_ATTEMPTS',
        source.MAX_DATABASE_ATTEMPTS,
        3,
        1,
        10,
      ),
      pendingReferencePollIntervalMs: parseIntegerSetting(
        'PENDING_REFERENCE_POLL_INTERVAL_MS',
        source.PENDING_REFERENCE_POLL_INTERVAL_MS,
        1000,
        1,
        3600000,
      ),
    },
  });
}

export function configuration(source: NodeJS.ProcessEnv = process.env) {
  const values = getEnvironment(source);
  return {
    nodeEnvironment: values.nodeEnvironment,
    app: values.app,
    database: values.database,
    auth: values.auth,
    sqs: values.sqs,
    workers: values.workers,
  };
}

export function getEnvironmentFilePaths(
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const environment = parseNodeEnvironment(source.NODE_ENV);
  if (environment === 'development') {
    return [
      join(process.cwd(), 'config', 'env', 'development.env'),
      '.env',
    ];
  }
  const suffix = {
    test: 'test',
    production: 'prod',
  }[environment];
  return [
    join(process.cwd(), 'config', 'env', `env.${suffix}`),
    join(process.cwd(), 'config', 'env', `${environment}.env`),
    '.env',
  ];
}
