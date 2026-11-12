export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}