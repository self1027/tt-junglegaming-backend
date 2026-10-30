import { expect, test } from 'bun:test';
import { CreateWalletUseCase } from '../src/modules/financial/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../src/modules/financial/application/reconcile-wallet.use-case.js';
import {
	Money,
	Wallet,
	WalletLedgerEntry,
} from '../src/modules/financial/public/index.js';
import type {
	FinancialTransactionContext,
	OpeningTransaction,
	UnitOfWork,
} from '../src/modules/financial/public/index.js';

function fixture(): {
	uow: UnitOfWork;
	entries: WalletLedgerEntry[];
	openings: OpeningTransaction[];
	wallets: Wallet[];
	options: unknown[];
} {
	const entries: WalletLedgerEntry[] = [];
	const openings: OpeningTransaction[] = [];
	const wallets: Wallet[] = [];
	const options: unknown[] = [];
	const context: FinancialTransactionContext = {
		wallets: {
			findById: id => Promise.resolve(wallets.find(w => w.id === id)),
			findByPlayerAndCurrency: () => Promise.resolve(undefined),
			lockById: () => Promise.reject(new Error('Read must not lock')),
			insert: w => {
				wallets.push(w);
				return Promise.resolve();
			},
			save: () => Promise.reject(new Error('Read must not write')),
		},
		ledger: {
			append: e => {
				entries.push(e);
				return Promise.resolve();
			},
			findByWalletId: () => Promise.resolve(entries),
		},
		openings: {
			insert: o => {
				openings.push(o);
				return Promise.resolve();
			},
		},
	};
	const uow: UnitOfWork = {
		execute: (work, option) => {
			options.push(option);
			return work(context);
		},
	};
	return { uow, entries, openings, wallets, options };
}

for (const amount of ['0.00', '100.00', '9007199254740993.01']) {
	test(`opens ${amount} at version 1 with exact matching history`, async () => {
		const f = fixture();
		const wallet = await new CreateWalletUseCase(f.uow).execute({
			playerId: 'player',
			initialBalance: { amount, currency: 'BRL' },
		});
		expect(wallet.balance.amount).toBe(amount);
		expect(wallet.version).toBe(1);
		expect(f.entries).toHaveLength(amount === '0.00' ? 0 : 1);
		expect(f.openings).toHaveLength(amount === '0.00' ? 0 : 1);
		const result = await new ReconcileWalletUseCase(f.uow).execute(
			wallet.id,
		);
		expect(result).toMatchObject({
			calculatedBalance: { amount, currency: 'BRL' },
			difference: { amount: '0.00', currency: 'BRL' },
			consistent: true,
		});
		expect(f.options.at(-1)).toEqual({ readOnly: true });
	});
}

for (const [stored, difference] of [
	['105.00', '5.00'],
	['95.00', '-5.00'],
] as const) {
	test(`reports signed difference ${difference} without repair`, async () => {
		const f = fixture();
		const result = await new CreateWalletUseCase(f.uow).execute({
			playerId: 'player',
			initialBalance: { amount: '100.00', currency: 'BRL' },
		});
		const original = f.wallets[0];
		if (original === undefined) throw new Error('Missing wallet');
		f.wallets[0] = Wallet.rehydrate({
			id: original.id,
			playerId: original.playerId,
			currency: original.currency,
			balance: Money.create({ amount: stored, currency: 'BRL' }),
			version: 1,
			createdAt: original.createdAt,
			updatedAt: original.updatedAt,
		});
		expect(
			await new ReconcileWalletUseCase(f.uow).execute(result.id),
		).toMatchObject({
			consistent: false,
			difference: { amount: difference, currency: 'BRL' },
		});
		expect(f.wallets[0].balance.toProps().amount).toBe(stored);
		expect(f.entries).toHaveLength(1);
	});
}

test('rejects invalid Unicode player and missing wallet before writing', () => {
	const f = fixture();
	expect(
		new CreateWalletUseCase(f.uow).execute({
			playerId: '\ud800',
			initialBalance: { amount: '0.00', currency: 'BRL' },
		}),
	).rejects.toThrow();
	expect(
		new ReconcileWalletUseCase(f.uow).execute(crypto.randomUUID()),
	).rejects.toThrow('WALLET_NOT_FOUND');
	expect(f.entries).toHaveLength(0);
	expect(f.wallets).toHaveLength(0);
});

test('reconstructs debits and reversals with equal timestamps in arbitrary id order', async () => {
	const f = fixture();
	const result = await new CreateWalletUseCase(f.uow).execute({
		playerId: 'player',
		initialBalance: { amount: '100.00', currency: 'BRL' },
	});
	const wallet = f.wallets[0];
	if (wallet === undefined) throw new Error('Missing wallet');
	for (const direction of ['DEBIT', 'CREDIT', 'DEBIT', 'CREDIT'] as const) {
		const change =
			direction === 'DEBIT'
				? wallet.debit(
						Money.create({ amount: '25.00', currency: 'BRL' }),
						wallet.updatedAt,
					)
				: wallet.credit(
						Money.create({ amount: '25.00', currency: 'BRL' }),
						wallet.updatedAt,
					);
		if (change === undefined) throw new Error('Missing change');
		f.entries.unshift(
			WalletLedgerEntry.create({
				...change,
				id: crypto.randomUUID(),
				transactionId: crypto.randomUUID(),
				createdAt: wallet.updatedAt,
			}),
		);
	}
	expect(
		await new ReconcileWalletUseCase(f.uow).execute(result.id),
	).toMatchObject({
		consistent: true,
		checkedEntries: 5,
		calculatedBalance: { amount: '100.00', currency: 'BRL' },
	});
});

test('detects disconnected historical balances even when net sum matches wallet', async () => {
	const f = fixture();
	const result = await new CreateWalletUseCase(f.uow).execute({
		playerId: 'player',
		initialBalance: { amount: '0.00', currency: 'BRL' },
	});
	const wallet = f.wallets[0];
	if (wallet === undefined) throw new Error('Missing wallet');
	wallet.credit(
		Money.create({ amount: '50.00', currency: 'BRL' }),
		wallet.updatedAt,
	);
	f.entries.push(
		WalletLedgerEntry.create({
			walletId: wallet.id,
			id: crypto.randomUUID(),
			transactionId: crypto.randomUUID(),
			direction: 'CREDIT',
			amount: Money.create({ amount: '50.00', currency: 'BRL' }),
			balanceBefore: Money.create({ amount: '100.00', currency: 'BRL' }),
			balanceAfter: Money.create({ amount: '150.00', currency: 'BRL' }),
			createdAt: wallet.updatedAt,
		}),
	);
	expect(
		await new ReconcileWalletUseCase(f.uow).execute(result.id),
	).toMatchObject({
		consistent: false,
		difference: { amount: '0.00', currency: 'BRL' },
	});
});
