import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class StructuredLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const record = {
      ...(message && typeof message === 'object' && !Array.isArray(message)
        ? message
        : { message }),
      timestamp: new Date().toISOString(),
      level,
      context,
      ...(trace ? { trace } : {}),
    };
    const serialized = JSON.stringify(record);
    if (level === 'error' || level === 'fatal') {
      console.error(serialized);
    } else {
      console.log(serialized);
    }
  }
}
