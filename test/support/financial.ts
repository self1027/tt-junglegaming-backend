import {
	Money,
	Wallet,
	WalletLedgerEntry,
} from '../../src/modules/financial/public/index.js';
import type {
	BalanceChange,
	FinancialTransactionContext,
} from '../../src/modules/financial/public/index.js';
import type {
	WageringTransactionContext,
	ProcessedWagerRecord,
} from '../../src/modules/wagering/public/persistence.js';

export const createdAt = new Date('2026-10-28T12:00:00.123Z');
export const changedAt = new Date('2026-10-28T12:01:00.456Z');

export function money(amount: string): Money {
	return Money.create({ amount, currency: 'BRL' });
}

export async function openWallet(
	context: FinancialTransactionContext,
	amount = '100.00',
): Promise<Wallet> {
	const wallet = Wallet.open({
		id: crypto.randomUUID(),
		playerId: crypto.randomUUID(),
		currency: 'BRL',
		createdAt,
		initialBalance: money(amount),
	});
	await context.wallets.insert(wallet);
	if (wallet.balance.isPositive()) {
		const transactionId = crypto.randomUUID();
		await context.openings.insert({
			id: transactionId,
			walletId: wallet.id,
			playerId: wallet.playerId,
			money: wallet.balance,
			createdAt,
		});
		await context.ledger.append(
			WalletLedgerEntry.create({
				id: crypto.randomUUID(),
				transactionId,
				walletId: wallet.id,
				direction: 'CREDIT',
				amount: wallet.balance,
				balanceBefore: Money.zero('BRL'),
				balanceAfter: wallet.balance,
				createdAt,
			}),
		);
	}
	return wallet;
}

export function wagerRecord(
	wallet: Wallet,
	change: BalanceChange,
	id: string = crypto.randomUUID(),
): ProcessedWagerRecord {
	return {
		id,
		walletId: wallet.id,
		playerId: wallet.playerId,
		providerId: 'integration-provider',
		externalTransactionId: id,
		idempotencyKey: id,
		payloadHash: 'integration-payload',
		roundId: 'round',
		gameId: 'game',
		kind: change.direction === 'CREDIT' ? 'WIN' : 'BET',
		money: change.amount,
		referenceExternalTransactionId: null,
		referenceTransactionId: null,
		createdAt: changedAt,
		processedAt: changedAt,
	};
}

export async function appendChange(
	context: WageringTransactionContext,
	wallet: Wallet,
	change: BalanceChange,
	entryId: string = crypto.randomUUID(),
): Promise<WalletLedgerEntry> {
	const record = wagerRecord(wallet, change);
	await context.transactions.insertProcessed(record);
	const entry = WalletLedgerEntry.create({
		...change,
		id: entryId,
		transactionId: record.id,
		createdAt: changedAt,
	});
	await context.ledger.append(entry);
	return entry;
}
