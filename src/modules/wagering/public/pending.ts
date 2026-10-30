import type { WagerTransaction } from '../domain/wager-transaction.js';

export interface PendingWagerClaim {
	readonly transaction: WagerTransaction;
	readonly token: string;
	readonly attempts: number;
}

export interface PendingWagerStore {
	claim(
		limit: number,
		owner: string,
		leaseMs: number,
	): Promise<readonly PendingWagerClaim[]>;
	retry(claim: PendingWagerClaim, delayMs: number): Promise<void>;
}

export interface PendingResolutionRepository {
	/** Caller already holds idempotency, external identity and wallet locks. */
	lock(
		claim: PendingWagerClaim,
		ttlMs: number,
	): Promise<
		| {
				transaction: WagerTransaction;
				at: Date;
				expired: boolean;
		  }
		| undefined
	>;
	/** Conditional final write; losing the lease must roll back the whole unit. */
	finish(
		claim: PendingWagerClaim,
		transaction: WagerTransaction,
		delayMs: number,
		reason: string | undefined,
	): Promise<void>;
}

export class PendingClaimLostError extends Error {
	constructor() {
		super('Pending wager claim lost or expired');
	}
}
