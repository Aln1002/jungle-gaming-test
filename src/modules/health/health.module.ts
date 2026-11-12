import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { HealthController, MetricsController } from './controllers/health.controller.js';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController, MetricsController],
})
export class HealthModule { }
