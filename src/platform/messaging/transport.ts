export interface ReceivedMessage {
	readonly body: string;
	readonly nativeId: string;
	readonly receiptHandle: string;
	readonly groupId: string;
	readonly deduplicationId: string;
	readonly receiveCount: number;
}

export interface MessageTransport {
	receive(
		max: number,
		signal: AbortSignal,
	): Promise<readonly ReceivedMessage[]>;
	ack(message: ReceivedMessage): Promise<void>;
	visibility(message: ReceivedMessage, seconds: number): Promise<void>;
	check(): Promise<void>;
	close(): void;
}

export interface MessageOutcome {
	readonly status: string;
	readonly messageId: string;
	readonly providerId?: string;
	readonly walletId?: string | undefined;
	readonly transactionId?: string;
	readonly correlationId?: string;
	readonly idempotentReplay?: boolean;
}

export class PermanentMessageError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'PermanentMessageError';
	}
}
