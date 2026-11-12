export interface SubmitContext {
  correlationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
  };
}