/** Stable producer identity; independent of broker receipt and business idempotency. */
export interface InboxDelivery {
	readonly consumerName: string;
	readonly messageId: string;
	readonly payloadHash: string;
}

export interface InboxRepository {
	/** Must acquire before business locks, on the same transaction. */
	claim(delivery: InboxDelivery): Promise<'CLAIMED' | 'PROCESSED'>;
	complete(delivery: InboxDelivery): Promise<void>;
}

export class InboxPayloadConflict extends Error {
	constructor() {
		super('INBOX_PAYLOAD_CONFLICT');
		this.name = 'InboxPayloadConflict';
	}
}
