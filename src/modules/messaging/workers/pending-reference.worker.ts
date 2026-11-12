import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentGlobalsEnum } from '../../../shared/enums/environment-globals.enum.js';
import { StructuredLogger } from '../../../shared/observability/structured-logger.js';
import { WageringService } from '../../wagering/services/wagering.service.js';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly wagering: WageringService,
    private readonly logger: StructuredLogger,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }
      this.running = this.wagering
        .reprocessPendingReferences()
        .catch((error: unknown) => {
          this.logger.error({
            event: 'pending_reference_worker_failed',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          });
        })
        .finally(() => {
          this.running = undefined;
        });
    }, this.configService.getOrThrow<number>(EnvironmentGlobalsEnum.PendingReferencePollIntervalMs));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.running;
  }
}
