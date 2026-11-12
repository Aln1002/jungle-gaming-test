import { ConfigService } from '@nestjs/config';
import { configuration } from '../../config/env/configuration.js';
import { describe, expect, it, spyOn } from 'bun:test';
import { DataSource } from 'typeorm';
import { getDataSourceOptions } from '../../src/database/data-source-options.js';
import { PendingReferenceWorker } from '../../src/modules/messaging/workers/pending-reference.worker.js';
import { WageringService } from '../../src/modules/wagering/services/wagering.service.js';
import { MetricsService } from '../../src/shared/observability/metrics.service.js';
import { StructuredLogger } from '../../src/shared/observability/structured-logger.js';
import { createWageringRepositories } from '../fixtures/wagering-repositories.js';

describe('PendingReferenceWorker shutdown', () => {
  it('waits for the in-flight job and does not start another', async () => {
    const logger = new StructuredLogger();
    const wagering = new WageringService(
      new DataSource(getDataSourceOptions()),
      new MetricsService(),
      logger,
      new ConfigService(configuration({ NODE_ENV: 'test' })),
      ...createWageringRepositories(),
    );
    let finish!: () => void;
    let started!: () => void;
    const jobStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const job = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const processing = spyOn(
      wagering,
      'reprocessPendingReferences',
    ).mockImplementation(() => {
      started();
      return job;
    });
    const worker = new PendingReferenceWorker(
      wagering,
      logger,
      new ConfigService({ workers: { pendingReferencePollIntervalMs: 5 } }),
    );
    worker.onModuleInit();
    try {
      await jobStarted;
      let stopped = false;
      const shutdown = worker.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Bun.sleep(20);
      expect(stopped).toBe(false);
      expect(processing).toHaveBeenCalledTimes(1);
      finish();
      await shutdown;
      expect(stopped).toBe(true);
      await Bun.sleep(20);
      expect(processing).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await worker.onModuleDestroy();
      processing.mockRestore();
    }
  });
});
