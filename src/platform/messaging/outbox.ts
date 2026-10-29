/** Durable infrastructure records; no business state is loaded by the publisher. */
export interface OutboxEvent {
	readonly eventId: string;
	readonly eventType: string;
	readonly eventVersion: number;
	readonly aggregateId: string;
	readonly correlationId: string;
	readonly causationId: string | null;
	readonly occurredAt: Date;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxClaim extends OutboxEvent {
	readonly token: string;
	readonly attempts: number;
	readonly claimedUntil: Date;
	readonly recovered: boolean;
}

export type ClaimResult =
	| 'UPDATED'
	| 'ALREADY_PUBLISHED'
	| 'CLAIM_LOST'
	| 'LEASE_EXPIRED'
	| 'MISSING';

export interface OutboxStore {
	claim(
		limit: number,
		owner: string,
		leaseMs: number,
	): Promise<readonly OutboxClaim[]>;
	published(claim: OutboxClaim): Promise<ClaimResult>;
	retry(
		claim: OutboxClaim,
		delayMs: number,
		code: string,
	): Promise<ClaimResult>;
	diagnostics(): Promise<{ pending: number; expired: number; lagMs: number }>;
}

export interface EventPublisher {
	publish(event: OutboxEvent, signal: AbortSignal): Promise<void>;
	check(): Promise<void>;
	close(): void;
}

export class InvalidOutboxEvent extends Error {
	constructor() {
		super('Invalid persisted integration event');
		this.name = 'InvalidOutboxEvent';
	}
}
