import { IntegrationEventEnvelope } from "../../wagering/interfaces/integration-event-envelope.interface.js";

export interface ClaimedOutboxMessage {
  id: string;
  aggregate_id: string;
  payload: IntegrationEventEnvelope;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  lease_token: string;
}