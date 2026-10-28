import type {
	FinancialTransactionContext,
	Money,
	UnitOfWork,
} from '../../financial/public/index.js';

/** Technical insertion contract; operation validation belongs to the future domain/use case. */
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
}

export interface WageringTransactionContext extends FinancialTransactionContext {
	readonly transactions: WagerTransactionRepository;
}

export type WageringUnitOfWork = UnitOfWork<WageringTransactionContext>;
