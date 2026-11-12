import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { StructuredLogger } from '../../../shared/observability/structured-logger.js';
import { SqsService } from '../../messaging/services/sqs.service.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  
  constructor(
    private readonly dataSource: DataSource,
    private readonly sqs: SqsService,
    private readonly logger: StructuredLogger,
  ) { }

  @Get('live')
  @ApiOperation({ summary: 'Check process liveness' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check PostgreSQL and SQS readiness' })
  async ready() {
    let postgres = false;
    let sqs = false;
    try {
      await this.dataSource.query('SELECT 1');
      postgres = true;
    } catch (error) {
      this.logger.warn({
        event: 'readiness_postgres_unavailable',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    sqs = await this.sqs.isReady();
    if (!postgres || !sqs) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { postgres, sqs },
      });
    }
    return { status: 'ready', checks: { postgres, sqs } };
  }
}

@ApiTags('Health')
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) { }

  @Get('metrics')
  @ApiOperation({ summary: 'Get process-local Prometheus metrics' })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return this.metrics.renderPrometheus();
  }
}
