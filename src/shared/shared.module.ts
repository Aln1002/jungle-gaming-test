import { Global, Module } from '@nestjs/common';
import { MetricsService } from './observability/metrics.service.js';
import { StructuredLogger } from './observability/structured-logger.js';

@Global()
@Module({
  providers: [MetricsService, StructuredLogger],
  exports: [MetricsService, StructuredLogger],
})
export class SharedModule {}
