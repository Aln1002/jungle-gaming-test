import { SubmitWagerDto } from "../../wagering/dtos/submit-wager.dto.js";

export interface WagerRequestEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  correlationId?: string;
  data: SubmitWagerDto & { idempotencyKey: string };
}