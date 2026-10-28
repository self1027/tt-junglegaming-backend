import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import {
	Wallet,
	WalletLedgerEntry,
	Money,
} from '../src/modules/financial/public/index.js';
import type { UnitOfWork } from '../src/modules/financial/public/index.js';
import type { WageringUnitOfWork } from '../src/modules/wagering/public/persistence.js';
import {
	WalletRow,
	WalletLedgerEntryRow,
	WagerTransactionRow,
} from '../src/platform/persistence/models.js';
import { command, startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import {
	appendChange,
	changedAt,
	createdAt,
	money,
	openWallet,
	wagerRecord,
} from './support/financial.js';

let postgres: TestPostgres | undefined;
let orm: MikroORM;
let uow: WageringUnitOfWork;

beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await command([process.execPath, 'run', 'db:migrate'], postgres.env);
	uow = createUnitOfWork(orm);
}, 90_000);

afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		await postgres?.close();
	}
}, 30_000);

async function reconcile(
	walletId: string,
	expected: string,
	version: number,
): Promise<void> {
	await uow.execute(async context => {
		const wallet = await context.wallets.findById(walletId);
		expect(wallet?.balance.toProps().amount).toBe(expected);
		expect(wallet?.version).toBe(version);
		const entries = await context.ledger.findByWalletId(walletId);
		let total = Money.zero('BRL');
		for (const entry of entries) {
			total =
				entry.direction === 'CREDIT'
					? total.add(entry.amount)
					: total.subtract(entry.amount);
		}
		expect(total.toProps().amount).toBe(expected);
	});
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('Missing test state');
	return value;
}

describe('financial persistence adapters on PostgreSQL', () => {
	test('opens atomically at version 1 and rehydrates exact Money, identities and timestamps', async () => {
		// The same composition satisfies a Financial-only consumer without a Wagering dependency.
		const financial: UnitOfWork = uow;
		const wallet = await financial.execute(context =>
			openWallet(context, '9007199254740993.99'),
		);
		await uow.execute(async context => {
			const loaded = required(
				await context.wallets.findByPlayerAndCurrency(
					wallet.playerId,
					'BRL',
				),
			);
			expect(loaded).toBeInstanceOf(Wallet);
			expect(loaded).not.toBe(wallet);
			expect(loaded.id).toBe(wallet.id);
			expect(loaded.createdAt).toEqual(createdAt);
			expect(loaded.updatedAt).toEqual(createdAt);
			expect(loaded.balance).toBeInstanceOf(Money);
			const entries = await context.ledger.findByWalletId(wallet.id);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toBeInstanceOf(WalletLedgerEntry);
			expect(entries[0]?.createdAt).toEqual(createdAt);
			const row = await orm.em
				.fork()
				.findOneOrFail(
					WagerTransactionRow,
					required(entries[0]).transactionId,
				);
			expect(row).toMatchObject({
				kind: 'OPENING',
				status: 'PROCESSED',
				amount: '9007199254740993.99',
				providerId: null,
			});
		});
		await reconcile(wallet.id, '9007199254740993.99', 1);
	});

	test('persists a cent above 53 bits; reads deterministic ledger order with timestamp ties', async () => {
		const wallet = await uow.execute(context =>
			openWallet(context, '9007199254740993.99'),
		);
		const ids = [
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000001',
		];
		await uow.execute(async context => {
			const locked = required(await context.wallets.lockById(wallet.id));
			for (const id of ids) {
				const change = required(
					locked.credit(money('0.01'), changedAt),
				);
				await context.wallets.save(locked);
				await appendChange(context, locked, change, id);
			}
		});
		await uow.execute(async context => {
			const entries = await context.ledger.findByWalletId(wallet.id);
			expect(entries.slice(1).map(entry => entry.id)).toEqual(
				[...ids].reverse(),
			);
			expect(entries[1]?.amount.toProps().amount).toBe('0.01');
			expect(entries[1]?.createdAt).toEqual(changedAt);
		});
		await reconcile(wallet.id, '9007199254740994.01', 3);
	});

	test('zero opening has no transaction/ledger; saves without change preserve version and time', async () => {
		const wallet = await uow.execute(context =>
			openWallet(context, '0.00'),
		);
		await uow.execute(async context => {
			const locked = required(await context.wallets.lockById(wallet.id));
			expect(await context.wallets.lockById(wallet.id)).toBe(locked);
			expect(locked.credit(money('0.00'), changedAt)).toBeUndefined();
			await context.wallets.save(locked);
			expect(locked.debit(money('0.00'), changedAt)).toBeUndefined();
			await context.wallets.save(locked);
			expect(
				(await context.wallets.findById(wallet.id))?.updatedAt,
			).toEqual(createdAt);
			expect(await context.ledger.findByWalletId(wallet.id)).toHaveLength(
				0,
			);
		});
		expect(
			await orm.em
				.fork()
				.count(WagerTransactionRow, { walletId: wallet.id }),
		).toBe(0);
		await reconcile(wallet.id, '0.00', 1);
	});

	test('returns undefined for absent wallets and rejects updates without this context lock', async () => {
		await uow.execute(async context => {
			expect(
				await context.wallets.findById(crypto.randomUUID()),
			).toBeUndefined();
			expect(
				await context.wallets.lockById(crypto.randomUUID()),
			).toBeUndefined();
			expect(
				await context.wallets.findByPlayerAndCurrency('absent', 'BRL'),
			).toBeUndefined();
		});
		const wallet = await uow.execute(context => openWallet(context));
		expect(
			uow.execute(async context => {
				const read = required(
					await context.wallets.findById(wallet.id),
				);
				await context.wallets.lockById(wallet.id);
				read.credit(money('1.00'), changedAt);
				await context.wallets.save(read);
			}),
		).rejects.toThrow('lockById');
		await reconcile(wallet.id, '100.00', 1);
	});

	test('refreshes a previously read wallet after acquiring its lock', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		await uow.execute(async first => {
			const stale = required(await first.wallets.findById(wallet.id));
			await uow.execute(async second => {
				const locked = required(
					await second.wallets.lockById(wallet.id),
				);
				const change = required(
					locked.credit(money('1.00'), changedAt),
				);
				await second.wallets.save(locked);
				await appendChange(second, locked, change);
			});
			const refreshed = required(await first.wallets.lockById(wallet.id));
			expect(refreshed.balance.toProps().amount).toBe('101.00');
			expect(stale.balance.toProps().amount).toBe('100.00');
			const change = required(refreshed.debit(money('10.00'), changedAt));
			await first.wallets.save(refreshed);
			await appendChange(first, refreshed, change);
		});
		await reconcile(wallet.id, '91.00', 3);
	});

	test('rolls back wallet and transaction when ledger FK fails; propagates constraint code', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		let transactionId = '';
		expect(
			uow.execute(async context => {
				const locked = required(
					await context.wallets.lockById(wallet.id),
				);
				const change = required(
					locked.debit(money('10.00'), changedAt),
				);
				await context.wallets.save(locked);
				const record = wagerRecord(locked, change);
				transactionId = record.id;
				await context.transactions.insertProcessed(record);
				await context.ledger.append(
					WalletLedgerEntry.create({
						...change,
						id: crypto.randomUUID(),
						transactionId: crypto.randomUUID(),
						createdAt: changedAt,
					}),
				);
			}),
		).rejects.toMatchObject({ code: '23503' });
		expect(
			await orm.em
				.fork()
				.count(WagerTransactionRow, { id: transactionId }),
		).toBe(0);
		expect(
			await orm.em
				.fork()
				.count(WalletLedgerEntryRow, { walletId: wallet.id }),
		).toBe(1);
		await reconcile(wallet.id, '100.00', 1);
	});

	test('rolls back the whole positive opening when a later ledger append violates uniqueness', async () => {
		let id = '';
		expect(
			uow.execute(async context => {
				const wallet = await openWallet(context);
				id = wallet.id;
				const entries = await context.ledger.findByWalletId(id);
				await context.ledger.append(required(entries[0]));
			}),
		).rejects.toMatchObject({ code: '23505' });
		expect(await orm.em.fork().count(WalletRow, { id })).toBe(0);
		expect(
			await orm.em.fork().count(WagerTransactionRow, { walletId: id }),
		).toBe(0);
		expect(
			await orm.em.fork().count(WalletLedgerEntryRow, { walletId: id }),
		).toBe(0);
	});

	test('rolls back transaction and ledger when PostgreSQL rejects the wallet update', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		// Fault injection is confined to a disposable DB and one wallet; adapters remain real.
		await orm.em.execute(
			`create function fail_wallet_update() returns trigger language plpgsql as $$ begin if new.id = '${wallet.id}'::uuid then raise exception 'injected wallet update failure' using errcode = '23514'; end if; return new; end; $$`,
		);
		await orm.em.execute(
			'create trigger test_wallet_failure before update on wallets for each row execute function fail_wallet_update()',
		);
		let transactionId = '';
		try {
			expect(
				uow.execute(async context => {
					const locked = required(
						await context.wallets.lockById(wallet.id),
					);
					const change = required(
						locked.debit(money('10.00'), changedAt),
					);
					transactionId = (
						await appendChange(context, locked, change)
					).transactionId;
					await context.wallets.save(locked);
				}),
			).rejects.toMatchObject({ code: '23514' });
		} finally {
			await orm.em.execute('drop trigger test_wallet_failure on wallets');
			await orm.em.execute('drop function fail_wallet_update()');
		}
		expect(
			await orm.em
				.fork()
				.count(WagerTransactionRow, { id: transactionId }),
		).toBe(0);
		expect(
			await orm.em.fork().count(WalletLedgerEntryRow, { transactionId }),
		).toBe(0);
		await reconcile(wallet.id, '100.00', 1);
	});

	test('propagates duplicate wallet constraints and arbitrary callback errors without partial effects', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		const duplicate = Wallet.create({
			id: crypto.randomUUID(),
			playerId: wallet.playerId,
			currency: 'BRL',
			createdAt,
		});
		expect(
			uow.execute(context => context.wallets.insert(duplicate)),
		).rejects.toMatchObject({ code: '23505' });
		const error = new Error('callback failure');
		expect(
			uow.execute(async context => {
				await context.wallets.insert(
					Wallet.create({
						id: crypto.randomUUID(),
						playerId: 'rolled-back',
						currency: 'BRL',
						createdAt,
					}),
				);
				throw error;
			}),
		).rejects.toBe(error);
		expect(
			await orm.em.fork().count(WalletRow, { playerId: 'rolled-back' }),
		).toBe(0);
	});
});
