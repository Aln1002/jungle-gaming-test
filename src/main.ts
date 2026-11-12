import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { InfrastructureExceptionFilter } from './shared/errors/infrastructure-exception.filter.js';
import { StructuredLogger } from './shared/observability/structured-logger.js';
import { EnvironmentGlobalsEnum } from './shared/enums/environment-globals.enum.js';
import { setupSwagger } from './shared/swagger/swagger.config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const configService = app.get(ConfigService);
  const logger = app.get(StructuredLogger);
  app.useLogger(logger);
  app.useGlobalFilters(
    new InfrastructureExceptionFilter(app.get(HttpAdapterHost)),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  const environment = configService.getOrThrow<string>(
    EnvironmentGlobalsEnum.NodeEnvironment,
  );
  const port = configService.getOrThrow<number>(EnvironmentGlobalsEnum.Port);
  if (environment !== 'production') {
    setupSwagger(app);
  }
  app.enableShutdownHooks();
  await app.listen(port);
  logger.log(
    {
      event: 'application_started',
      message: 'Distributed Wagering Processor API started',
      environment,
      port,
      ...(environment !== 'production' ? { docsPath: '/docs' } : {}),
    },
    'Bootstrap',
  );
}

await bootstrap();
