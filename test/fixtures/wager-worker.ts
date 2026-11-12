import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { configuration } from '../../config/env/configuration.js';
import { getDataSourceOptions } from '../../src/database/data-source-options.js';
import { MetricsService } from '../../src/shared/observability/metrics.service.js';
import { StructuredLogger } from '../../src/shared/observability/structured-logger.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import type { SubmitWagerInput } from '../../src/modules/wagering/interfaces/submit-wager-input.interface.js';
import { createWageringRepositories } from './wagering-repositories.js';

class QuietLogger extends StructuredLogger {
  override log(): void {}

  override warn(): void {}

  override error(): void {}
}

interface WorkerRequest {
  input: SubmitWagerInput;
  idempotencyKey: string;
}

const request = JSON.parse(process.env.WAGER_REQUEST ?? '') as WorkerRequest;
const dataSource = new DataSource({
  ...getDataSourceOptions(),
  migrationsRun: false,
});

try {
  await dataSource.initialize();
  const service = new WageringService(
    dataSource,
    new MetricsService(),
    new QuietLogger(),
    new ConfigService(configuration()),
    ...createWageringRepositories(),
  );
  const result = await service.submit(request.input, request.idempotencyKey);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Unknown worker failure',
  );
  process.exitCode = 1;
} finally {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}
