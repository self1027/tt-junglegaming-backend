import type {
	FinancialTransactionContext,
	Money,
	UnitOfWork,
} from '../../financial/public/index.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { WagerReversalKind } from '../domain/wager-types.js';
import type { ProcessWagerResult } from './process-wager.js';
import type { OutboxRepository } from './events.js';
import type { InboxRepository } from './inbox.js';
import type { PendingResolutionRepository } from './pending.js';

/** Compatibility contract for technical insertion; the use case persists domain entities. */
export interface ProcessedWagerRecord {
	readonly id: string;
	readonly walletId: string;
	readonly playerId: string;
	readonly providerId: string;
	readonly externalTransactionId: string;
	readonly idempotencyKey: string;
	readonly payloadHash: string;
	readonly roundId: string;
	readonly gameId: string;
	readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
	readonly money: Money;
	readonly referenceExternalTransactionId: string | null;
	readonly referenceTransactionId: string | null;
	readonly createdAt: Date;
	readonly processedAt: Date;
}

export interface WagerTransactionRepository {
	insertProcessed(record: ProcessedWagerRecord): Promise<void>;
	/** Acquire before wallet locks. No reference identity lock is acquired. */
	lockExternalIdentity(
		providerId: string,
		externalTransactionId: string,
	): Promise<void>;
	findById(id: string): Promise<WagerTransaction | undefined>;
	findByExternalIdentity(
		providerId: string,
		externalTransactionId: string,
	): Promise<WagerTransaction | undefined>;
	insert(transaction: WagerTransaction): Promise<void>;
	/** Caller holds the wallet lock; terminal persisted states cannot be replaced. */
	save(transaction: WagerTransaction): Promise<void>;
	findProcessedReversalKinds(
		referenceTransactionId: string,
	): Promise<readonly WagerReversalKind[]>;
	/** Caller holds the wallet lock. Only a processed, matching rollback counts. */
	hasReversedRefund(betTransactionId: string): Promise<boolean>;
}

export type IdempotencyClaim =
	| { readonly type: 'CLAIMED' }
	| {
			readonly type: 'EXISTING';
			readonly payloadHash: string;
			readonly result: ProcessWagerResult | undefined;
	  };

export interface IdempotencyRepository {
	lockResult(
		scope: string,
		key: string,
		payloadHash: string,
		transactionId: string,
	): Promise<ProcessWagerResult | undefined>;
	resolvePending(
		scope: string,
		key: string,
		payloadHash: string,
		result: ProcessWagerResult,
	): Promise<void>;
	/** INSERT ON CONFLICT waits for the competing transaction, then reads under lock. */
	claim(
		scope: string,
		key: string,
		payloadHash: string,
	): Promise<IdempotencyClaim>;
	complete(
		scope: string,
		key: string,
		payloadHash: string,
		result: ProcessWagerResult,
	): Promise<void>;
}

export interface WageringTransactionContext extends FinancialTransactionContext {
	readonly pending?: PendingResolutionRepository;
	readonly inbox?: InboxRepository;
	readonly transactions: WagerTransactionRepository;
	readonly idempotency: IdempotencyRepository;
	readonly outbox: OutboxRepository;
}

export type WageringUnitOfWork = UnitOfWork<WageringTransactionContext>;
