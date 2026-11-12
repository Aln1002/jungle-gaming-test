export interface ReceivedQueueMessage {
  messageId?: string;
  receiptHandle?: string;
  body?: string;
  approximateReceiveCount?: number;
}