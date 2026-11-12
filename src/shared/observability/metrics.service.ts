import { Injectable } from '@nestjs/common';

interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly processingLatency: Histogram = {
    count: 0,
    sum: 0,
    buckets: LATENCY_BUCKETS.map(() => 0),
  };
  private outboxLagMilliseconds = 0;
  private deadLetterMessages = 0;
  private lockConflicts = 0;

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  recordProcessingLatency(milliseconds: number): void {
    this.processingLatency.count += 1;
    this.processingLatency.sum += milliseconds;
    LATENCY_BUCKETS.forEach((bucket, index) => {
      if (milliseconds <= bucket) {
        this.processingLatency.buckets[index] += 1;
      }
    });
  }

  setOutboxLag(milliseconds: number): void {
    this.outboxLagMilliseconds = Math.max(0, milliseconds);
  }

  setDeadLetterMessages(count: number): void {
    this.deadLetterMessages = Math.max(0, count);
  }

  recordLockConflict(): void {
    this.lockConflicts += 1;
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP wagering_events_total Wagering processor events.',
      '# TYPE wagering_events_total counter',
      ...[...this.counters.entries()].map(
        ([name, value]) => `wagering_events_total{event="${name}"} ${value}`,
      ),
      '# HELP wagering_processing_duration_milliseconds Processing latency.',
      '# TYPE wagering_processing_duration_milliseconds histogram',
      ...LATENCY_BUCKETS.map(
        (bucket, index) =>
          `wagering_processing_duration_milliseconds_bucket{le="${bucket}"} ${this.processingLatency.buckets[index]}`,
      ),
      `wagering_processing_duration_milliseconds_bucket{le="+Inf"} ${this.processingLatency.count}`,
      `wagering_processing_duration_milliseconds_sum ${this.processingLatency.sum}`,
      `wagering_processing_duration_milliseconds_count ${this.processingLatency.count}`,
      '# HELP wagering_outbox_lag_milliseconds Age of the oldest pending outbox event.',
      '# TYPE wagering_outbox_lag_milliseconds gauge',
      `wagering_outbox_lag_milliseconds ${this.outboxLagMilliseconds}`,
      '# HELP wagering_dlq_messages Current messages in the transaction dead-letter queue.',
      '# TYPE wagering_dlq_messages gauge',
      `wagering_dlq_messages ${this.deadLetterMessages}`,
      '# HELP wagering_lock_conflicts_total Database lock conflicts.',
      '# TYPE wagering_lock_conflicts_total counter',
      `wagering_lock_conflicts_total ${this.lockConflicts}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
