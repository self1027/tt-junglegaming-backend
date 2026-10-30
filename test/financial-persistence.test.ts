import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import {
	Wallet,
	WalletLedgerEntry,
	Money,
} from '../src/modules/financial/public/index.js';
import type {
	FinancialTransactionContext,
	UnitOfWork,
} from '../src/modules/financial/public/index.js';
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
import { financialChild } from './support/financial-child.js';

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

async function waitForBlocked(pids: number[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const rows = await orm.em.execute<{ application_name: string }[]>(
			"select application_name from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
		);
		if (
			pids.every(pid =>
				rows.some(
					row =>
						row.application_name ===
						`financial-test-${String(pid)}`,
				),
			)
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error('Contenders did not reach PostgreSQL lock wait');
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

	test('isolates overlapping executions and rejects all repositories after their context closes', async () => {
		const wallet = Wallet.create({
			id: crypto.randomUUID(),
			playerId: crypto.randomUUID(),
			currency: 'BRL',
			createdAt,
		});
		let escaped: FinancialTransactionContext | undefined;
		await uow.execute(async outer => {
			escaped = outer;
			await outer.wallets.insert(wallet);
			await uow.execute(async inner => {
				expect(inner).not.toBe(outer);
				expect(await inner.wallets.findById(wallet.id)).toBeUndefined();
			});
		});
		const closed = required(escaped);
		expect(closed.wallets.findById(wallet.id)).rejects.toThrow(
			'not active',
		);
		expect(closed.wallets.lockById(wallet.id)).rejects.toThrow(
			'not active',
		);
		expect(closed.wallets.save(wallet)).rejects.toThrow('not active');
		expect(closed.ledger.findByWalletId(wallet.id)).rejects.toThrow(
			'not active',
		);
		expect(
			closed.openings.insert({
				id: crypto.randomUUID(),
				walletId: wallet.id,
				playerId: wallet.playerId,
				money: money('1.00'),
				createdAt,
			}),
		).rejects.toThrow('not active');
		await reconcile(wallet.id, '0.00', 1);
	});

	test('closes the failed context and keeps its writes separate from another execution', async () => {
		const wallets = await Promise.all(
			[0, 1].map(() => uow.execute(context => openWallet(context))),
		);
		let failed: FinancialTransactionContext | undefined;
		expect(
			uow.execute(async outer => {
				failed = outer;
				const wallet = required(
					await outer.wallets.lockById(required(wallets[0]).id),
				);
				const change = required(
					wallet.credit(money('1.00'), changedAt),
				);
				await outer.wallets.save(wallet);
				await appendChange(outer, wallet, change);
				await uow.execute(async inner => {
					const other = required(
						await inner.wallets.lockById(required(wallets[1]).id),
					);
					const otherChange = required(
						other.credit(money('1.00'), changedAt),
					);
					await inner.wallets.save(other);
					await appendChange(inner, other, otherChange);
				});
				throw new Error('outer rollback');
			}),
		).rejects.toThrow('outer rollback');
		expect(
			required(failed).wallets.findById(required(wallets[0]).id),
		).rejects.toThrow('not active');
		await reconcile(required(wallets[0]).id, '100.00', 1);
		await reconcile(required(wallets[1]).id, '101.00', 2);
	});

	test('releases connections after more successes/failures than the pool capacity', async () => {
		const isolated = await testOrm({
			...required(postgres),
			config: { ...required(postgres).config, pool: { min: 0, max: 2 } },
		});
		try {
			const bounded = createUnitOfWork(isolated);
			for (let index = 0; index < 8; index += 1) {
				await bounded.execute(context =>
					context.wallets.findById(crypto.randomUUID()),
				);
				expect(
					bounded.execute(async context => {
						await context.wallets.findById(crypto.randomUUID());
						throw new Error('rollback');
					}),
				).rejects.toThrow('rollback');
			}
			const sessions = await isolated.em.execute<{ count: number }[]>(
				"select count(*)::int as count from pg_stat_activity where datname = current_database() and state = 'idle in transaction'",
			);
			expect(sessions[0]?.count).toBe(0);
		} finally {
			await isolated.close(true);
		}
	}, 15_000);

	test('serializes three independent processes on one wallet without lost cent updates', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		const children = ['hold-credit', 'credit', 'credit'].map(mode =>
			financialChild(required(postgres).env, wallet.id, mode),
		);
		try {
			expect(new Set(children.map(child => child.pid)).size).toBe(3);
			expect(
				await Promise.all(children.map(child => child.next())),
			).toEqual(['ready', 'ready', 'ready']);
			const holder = required(children[0]);
			await holder.signal();
			expect(await holder.next()).toBe('locked');
			for (const child of children.slice(1)) await child.signal();
			await waitForBlocked(children.slice(1).map(child => child.pid));
			await holder.signal();
			expect(await holder.next()).toBe('committed');
			for (const child of children.slice(1)) {
				expect(await child.next()).toBe('locked');
				expect(await child.next()).toBe('committed');
			}
			await reconcile(wallet.id, '100.03', 4);
			expect(
				await orm.em
					.fork()
					.count(WalletLedgerEntryRow, { walletId: wallet.id }),
			).toBe(4);
		} finally {
			await Promise.all(children.map(child => child.close()));
		}
	}, 30_000);

	test('allows two other wallets to commit while a third process holds a wallet lock', async () => {
		const wallets = await Promise.all(
			[0, 1, 2].map(() => uow.execute(context => openWallet(context))),
		);
		const children = wallets.map((wallet, index) =>
			financialChild(
				required(postgres).env,
				wallet.id,
				index === 0 ? 'hold-credit' : 'credit',
			),
		);
		try {
			expect(
				await Promise.all(children.map(child => child.next())),
			).toEqual(['ready', 'ready', 'ready']);
			const holder = required(children[0]);
			await holder.signal();
			expect(await holder.next()).toBe('locked');
			for (const child of children.slice(1)) await child.signal();
			for (const child of children.slice(1)) {
				expect(await child.next()).toBe('locked');
				expect(await child.next()).toBe('committed');
			}
			// Independent readers still observe the holder's pre-commit state.
			await reconcile(required(wallets[0]).id, '100.00', 1);
			await holder.signal();
			expect(await holder.next()).toBe('committed');
			for (const wallet of wallets)
				await reconcile(wallet.id, '100.01', 2);
		} finally {
			await Promise.all(children.map(child => child.close()));
		}
	}, 30_000);

	test('releases locks on rollback; two independent debits cannot overspend the same balance', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		const children = ['hold-rollback', 'debit', 'debit'].map(mode =>
			financialChild(required(postgres).env, wallet.id, mode),
		);
		try {
			expect(
				await Promise.all(children.map(child => child.next())),
			).toEqual(['ready', 'ready', 'ready']);
			const holder = required(children[0]);
			await holder.signal();
			expect(await holder.next()).toBe('locked');
			for (const child of children.slice(1)) await child.signal();
			await waitForBlocked(children.slice(1).map(child => child.pid));
			await holder.signal();
			expect(await holder.next()).toBe('rolled-back');
			const results: string[] = [];
			for (const child of children.slice(1)) {
				expect(await child.next()).toBe('locked');
				results.push(await child.next());
			}
			expect(results.sort()).toEqual(['committed', 'insufficient']);
			await reconcile(wallet.id, '20.00', 2);
			expect(
				await orm.em.fork().count(WalletLedgerEntryRow, {
					walletId: wallet.id,
					direction: 'DEBIT',
				}),
			).toBe(1);
			expect(
				await orm.em
					.fork()
					.count(WagerTransactionRow, { walletId: wallet.id }),
			).toBe(2);
		} finally {
			await Promise.all(children.map(child => child.close()));
		}
	}, 30_000);

	test('propagates PostgreSQL lock acquisition timeout without retry or financial effects', async () => {
		const wallet = await uow.execute(context => openWallet(context));
		const children = ['hold-rollback', 'timeout'].map(mode =>
			financialChild(required(postgres).env, wallet.id, mode),
		);
		try {
			expect(
				await Promise.all(children.map(child => child.next())),
			).toEqual(['ready', 'ready']);
			const holder = required(children[0]);
			const contender = required(children[1]);
			await holder.signal();
			expect(await holder.next()).toBe('locked');
			await contender.signal();
			expect(await contender.next()).toBe('55P03');
			expect(contender.diagnostics).toContainEqual({
				pid: contender.pid,
				event: 'database_conflict',
				code: '55P03',
				metrics: [
					{
						name: 'lock_conflicts_total',
						kind: 'counter',
						value: 1,
						labels: {},
					},
				],
			});
			await holder.signal();
			expect(await holder.next()).toBe('rolled-back');
			await reconcile(wallet.id, '100.00', 1);
		} finally {
			await Promise.all(children.map(child => child.close()));
		}
	}, 30_000);
});
