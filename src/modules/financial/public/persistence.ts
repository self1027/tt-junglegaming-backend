import type { Money } from '../domain/money.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

export interface WalletRepository {
	findById(id: string): Promise<Wallet | undefined>;
	findByPlayerAndCurrency(
		playerId: string,
		currency: string,
	): Promise<Wallet | undefined>;
	lockById(id: string): Promise<Wallet | undefined>;
	insert(wallet: Wallet): Promise<void>;
	/** Requires the instance returned by lockById in this context. */
	save(wallet: Wallet): Promise<void>;
}

export interface WalletLedgerRepository {
	append(entry: WalletLedgerEntry): Promise<void>;
	/** Ascending createdAt, then id; timestamps alone are not unique. */
	findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]>;
}

export interface OpeningTransaction {
	readonly id: string;
	readonly walletId: string;
	readonly playerId: string;
	readonly money: Money;
	readonly createdAt: Date;
}

export interface OpeningTransactionRepository {
	insert(record: OpeningTransaction): Promise<void>;
}

export interface FinancialTransactionContext {
	readonly wallets: WalletRepository;
	readonly ledger: WalletLedgerRepository;
	readonly openings: OpeningTransactionRepository;
}

export interface UnitOfWork<
	Context extends FinancialTransactionContext = FinancialTransactionContext,
> {
	/** Resolves after commit; rejects after rollback. Context cannot escape the callback. */
	execute<T>(work: (context: Context) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
