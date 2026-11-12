import { InboxMessageState } from "../interfaces/inbox-message-state.interface.js";

export class InboxMessage {
  private constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(state: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed())
      throw new Error('Inbox message is already processed');
    this._processedAt = at;
  }
}
