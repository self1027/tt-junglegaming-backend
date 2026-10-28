import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type InferEntity, LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
	WalletRow,
	WagerTransactionRow,
	WalletLedgerEntryRow,
	InboxMessageRow,
	OutboxMessageRow,
	IdempotencyRecordRow,
} from '../src/platform/persistence/models.js';
import { command, startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';

let postgres: TestPostgres | undefined;
let orm: MikroORM;
function database(): TestPostgres {
	if (postgres === undefined) throw new Error('Test PostgreSQL not started');
	return postgres;
}

const uuid = (): string => crypto.randomUUID();

beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(database());
	await command([process.execPath, 'run', 'db:migrate'], database().env);
}, 90_000);

afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		await postgres?.close();
	}
}, 30_000);

function wallet(balance = '100.00'): InferEntity<typeof WalletRow> {
	return orm.em
		.fork()
		.create(
			WalletRow,
			{ id: uuid(), playerId: uuid(), currency: 'BRL', balance },
			{ persist: false },
		);
}

function wager(
	walletId: string,
	playerId: string,
): InferEntity<typeof WagerTransactionRow> {
	return orm.em.fork().create(
		WagerTransactionRow,
		{
			id: uuid(),
			walletId,
			playerId,
			providerId: 'provider-a',
			externalTransactionId: uuid(),
			idempotencyKey: uuid(),
			payloadHash: 'opaque-hash',
			roundId: 'round-a',
			gameId: 'game-a',
			kind: 'BET',
			amount: '10.00',
			currency: 'BRL',
		},
		{ persist: false },
	);
}

async function seed(): Promise<{
	wallet: InferEntity<typeof WalletRow>;
	transaction: InferEntity<typeof WagerTransactionRow>;
}> {
	const row = wallet();
	const transaction = wager(row.id, row.playerId);
	await orm.em.fork().persist([row, transaction]).flush();
	return { wallet: row, transaction };
}

function violation(sql: string, params: unknown[], code: string): void {
	expect(orm.em.fork().execute(sql, params)).rejects.toMatchObject({ code });
}

describe('PostgreSQL foundation', () => {
	test('applies on an empty database, down/up is reversible with disposable data', async () => {
		expect(
			(await orm.migrator.getExecuted()).map(entry => entry.name),
		).toEqual(['Migration202610280001']);
		expect(await orm.migrator.getPending()).toHaveLength(0);
		await orm.em.fork().persist(wallet()).flush();
		await command([process.execPath, 'run', 'db:rollback'], database().env);
		const tables = await orm.em.execute<{ name: string | null }[]>(
			"select to_regclass('wallets')::text as name",
		);
		expect(tables[0]?.name).toBeNull();
		expect(
			await command(
				[process.execPath, 'run', 'db:status'],
				database().env,
			),
		).toContain('No migrations executed yet');
		await command([process.execPath, 'run', 'db:migrate'], database().env);
		expect(
			await command(
				[process.execPath, 'run', 'db:status'],
				database().env,
			),
		).toContain('Migration202610280001');
		expect(await orm.em.fork().count(WalletRow)).toBe(0);
	});

	test('creates all six tables, foreign keys, constraints, indexes and ledger trigger', async () => {
		const tables = await orm.em.execute<{ tablename: string }[]>(
			"select tablename from pg_tables where schemaname = 'public'",
		);
		for (const name of [
			'wallets',
			'wager_transactions',
			'wallet_ledger_entries',
			'inbox_messages',
			'outbox_messages',
			'idempotency_records',
		]) {
			expect(tables.map(row => row.tablename)).toContain(name);
		}
		const indexes = await orm.em.execute<{ indexname: string }[]>(
			"select indexname from pg_indexes where schemaname = 'public'",
		);
		for (const name of [
			'wallets_player_currency_unique',
			'wager_external_identity_unique',
			'ledger_transaction_wallet_unique',
			'inbox_consumer_message_unique',
			'outbox_event_id_unique',
			'idempotency_scope_key_unique',
			'wager_pending_reference_idx',
			'outbox_pending_due_idx',
			'wager_processed_reversal_unique',
			'ledger_wallet_history_idx',
			'wager_reference_idx',
			'idempotency_transaction_idx',
		]) {
			expect(indexes.map(row => row.indexname)).toContain(name);
		}
		const fks = await orm.em.execute<{ conname: string }[]>(
			"select conname from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace",
		);
		expect(fks.map(row => row.conname).sort()).toEqual([
			'idempotency_transaction_fk',
			'ledger_transaction_fk',
			'ledger_wallet_fk',
			'wager_reference_fk',
			'wager_wallet_fk',
		]);
		const dates = await orm.em.execute<{ data_type: string }[]>(
			"select data_type from information_schema.columns where table_schema = 'public' and column_name in ('created_at', 'updated_at', 'processed_at', 'published_at', 'next_attempt_at', 'occurred_at', 'received_at', 'last_attempt_at')",
		);
		expect(
			dates.every(row => row.data_type === 'timestamp with time zone'),
		).toBe(true);
	});

	test('rejects duplicate player/currency wallets, permits other currencies', async () => {
		const row = wallet();
		await orm.em.fork().persist(row).flush();
		violation(
			'insert into wallets (id, player_id, currency, balance) values (?, ?, ?, ?)',
			[uuid(), row.playerId, 'BRL', '0.00'],
			'23505',
		);
		await orm.em.execute(
			'insert into wallets (id, player_id, currency, balance) values (?, ?, ?, ?)',
			[uuid(), row.playerId, 'USD', '0.00'],
		);
	});

	for (const balance of [
		'-0.01',
		'1.001',
		'NaN',
		'Infinity',
		'-Infinity',
		'1',
	]) {
		test(`rejects invalid balance ${balance} without rounding`, () => {
			violation(
				'insert into wallets (id, player_id, currency, balance) values (?, ?, ?, ?)',
				[uuid(), uuid(), 'BRL', balance],
				'23514',
			);
		});
	}

	test('rejects wallet versions below 1 and malformed currency', () => {
		violation(
			'insert into wallets (id, player_id, currency, balance, version) values (?, ?, ?, ?, ?)',
			[uuid(), uuid(), 'BRL', '0.00', 0],
			'23514',
		);
		violation(
			'insert into wallets (id, player_id, currency, balance) values (?, ?, ?, ?)',
			[uuid(), uuid(), 'brl', '0.00'],
			'23514',
		);
	});

	test('preserves exact decimal strings and ORM dirty checking above number precision', async () => {
		const row = wallet('123456789012345678901234567890.12');
		await orm.em.fork().persist(row).flush();
		const em = orm.em.fork();
		const loaded = await em.findOneOrFail(WalletRow, row.id);
		expect(typeof loaded.balance).toBe('string');
		expect(loaded.balance).toBe('123456789012345678901234567890.12');
		loaded.balance = '123456789012345678901234567890.13';
		await em.flush();
		expect(
			(await orm.em.fork().findOneOrFail(WalletRow, row.id)).balance,
		).toBe(loaded.balance);
	});

	test('rejects duplicate external transaction identity per provider', async () => {
		const { wallet: row, transaction } = await seed();
		const duplicate = { ...transaction, id: uuid() };
		expect(
			orm.em.fork().insert(WagerTransactionRow, duplicate),
		).rejects.toMatchObject({ code: '23505' });
		await orm.em.fork().insert(WagerTransactionRow, {
			...duplicate,
			providerId: 'provider-b',
		});
		expect(row.id).toBe(transaction.walletId);
	});

	test('limits successful reversals by reference and kind without hiding rejected attempts', async () => {
		const { transaction } = await seed();
		const reversal = {
			...transaction,
			id: uuid(),
			externalTransactionId: uuid(),
			kind: 'REFUND' as const,
			status: 'PROCESSED' as const,
			referenceTransactionId: transaction.id,
			referenceExternalTransactionId: transaction.externalTransactionId,
		};
		await orm.em.fork().insert(WagerTransactionRow, reversal);
		expect(
			orm.em.fork().insert(WagerTransactionRow, {
				...reversal,
				id: uuid(),
				externalTransactionId: uuid(),
			}),
		).rejects.toMatchObject({ code: '23505' });
		await orm.em.fork().insert(WagerTransactionRow, {
			...reversal,
			id: uuid(),
			externalTransactionId: uuid(),
			kind: 'ROLLBACK',
		});
		await orm.em.fork().insert(WagerTransactionRow, {
			...reversal,
			id: uuid(),
			externalTransactionId: uuid(),
			status: 'REJECTED',
		});
	});

	test('stores OPENING without external identity and unresolved references without a phantom FK', async () => {
		const row = wallet();
		await orm.em.fork().persist(row).flush();
		await orm.em.fork().insert(WagerTransactionRow, {
			walletId: row.id,
			playerId: row.playerId,
			currency: 'BRL',
			kind: 'OPENING',
			amount: '100.00',
		});
		const pending = wager(row.id, row.playerId);
		pending.kind = 'REFUND';
		pending.status = 'PENDING_REFERENCE';
		pending.referenceExternalTransactionId = 'has-not-arrived';
		pending.nextAttemptAt = new Date();
		await orm.em.fork().persist(pending).flush();
		const loaded = await orm.em
			.fork()
			.findOneOrFail(WagerTransactionRow, pending.id);
		expect(loaded.referenceTransactionId).toBeNull();
		expect(loaded.referenceExternalTransactionId).toBe('has-not-arrived');
	});

	test('rejects duplicate Inbox per consumer and retains processing metadata', async () => {
		const entry = {
			consumerName: 'wager-consumer',
			messageId: uuid(),
			payloadHash: 'hash',
		};
		await orm.em.fork().insert(InboxMessageRow, entry);
		expect(
			orm.em.fork().insert(InboxMessageRow, entry),
		).rejects.toMatchObject({ code: '23505' });
		await orm.em.fork().insert(InboxMessageRow, {
			...entry,
			consumerName: 'other-consumer',
		});
	});

	test('rejects duplicate Outbox event ID, preserves envelope and recovers pending records', async () => {
		const eventId = uuid();
		const entry = {
			eventId,
			aggregateId: uuid(),
			eventType: 'WalletBalanceChanged',
			eventVersion: 1,
			correlationId: uuid(),
			payload: { eventId, data: { amount: '10.00' } },
			occurredAt: new Date(),
		};
		await orm.em.fork().insert(OutboxMessageRow, entry);
		expect(
			orm.em.fork().insert(OutboxMessageRow, entry),
		).rejects.toMatchObject({ code: '23505' });
		violation(
			'update outbox_messages set event_id = ? where event_id = ?',
			[uuid(), eventId],
			'23514',
		);
		await orm.em.execute(
			'update outbox_messages set attempts = attempts + 1 where event_id = ?',
			[eventId],
		);
		const independent = await testOrm(database());
		try {
			const loaded = await independent.em
				.fork()
				.findOneOrFail(OutboxMessageRow, {
					eventId,
					status: 'PENDING',
				});
			expect(loaded.payload).toEqual(entry.payload);
			expect(loaded.nextAttemptAt).toBeInstanceOf(Date);
		} finally {
			await independent.close(true);
		}
	});

	test('rejects duplicate idempotency scope/key and preserves the original replay result', async () => {
		const { transaction } = await seed();
		const entry = {
			scope: 'provider-a',
			idempotencyKey: uuid(),
			payloadHash: 'canonical-hash-not-implemented',
			transactionId: transaction.id,
			status: 'COMPLETED' as const,
			originalResult: {
				transactionId: transaction.id,
				status: 'PROCESSED',
				balance: { amount: '90.00', currency: 'BRL' },
				idempotentReplay: false,
			},
		};
		await orm.em.fork().insert(IdempotencyRecordRow, entry);
		expect(
			orm.em.fork().insert(IdempotencyRecordRow, entry),
		).rejects.toMatchObject({ code: '23505' });
		await orm.em.execute('update wallets set balance = ? where id = ?', [
			'200.00',
			transaction.walletId,
		]);
		expect(
			(
				await orm.em.fork().findOneOrFail(IdempotencyRecordRow, {
					scope: entry.scope,
					idempotencyKey: entry.idempotencyKey,
				})
			).originalResult,
		).toEqual(entry.originalResult);
		violation(
			"insert into idempotency_records (id, scope, idempotency_key, payload_hash, status) values (?, ?, ?, ?, 'COMPLETED')",
			[uuid(), 'scope', uuid(), 'hash'],
			'23514',
		);
	});

	test('rejects inconsistent technical states, attempts and missing foreign transaction IDs', () => {
		violation(
			"insert into inbox_messages (consumer_name, message_id, payload_hash, status) values ('state', ?, 'hash', 'PROCESSED')",
			[uuid()],
			'23514',
		);
		violation(
			"insert into inbox_messages (consumer_name, message_id, payload_hash, attempts) values ('state', ?, 'hash', -1)",
			[uuid()],
			'23514',
		);
		violation(
			"insert into outbox_messages (event_id, aggregate_id, event_type, event_version, correlation_id, payload, occurred_at, status) values (?, ?, 'test', 1, 'trace', '{}', current_timestamp, 'PUBLISHED')",
			[uuid(), uuid()],
			'23514',
		);
		violation(
			"insert into wallet_ledger_entries (wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after) values (?, ?, 'CREDIT', 'BRL', '10.00', '0.00', '10.00')",
			[uuid(), uuid()],
			'23503',
		);
	});

	test('enforces foreign keys and wallet/player/currency consistency', async () => {
		const { wallet: row, transaction } = await seed();
		expect(
			orm.em.fork().insert(WagerTransactionRow, {
				...transaction,
				id: uuid(),
				externalTransactionId: uuid(),
				walletId: uuid(),
			}),
		).rejects.toMatchObject({ code: '23503' });
		expect(
			orm.em.fork().insert(WagerTransactionRow, {
				...transaction,
				id: uuid(),
				externalTransactionId: uuid(),
				currency: 'USD',
			}),
		).rejects.toMatchObject({ code: '23503' });
		violation(
			'update wager_transactions set reference_transaction_id = ? where id = ?',
			[uuid(), transaction.id],
			'23503',
		);
		expect(
			orm.em.execute('delete from wallets where id = ?', [row.id]),
		).rejects.toThrow('wager_wallet_fk');
		violation(
			'insert into idempotency_records (id, scope, idempotency_key, payload_hash, transaction_id) values (?, ?, ?, ?, ?)',
			[uuid(), 'scope', uuid(), 'hash', uuid()],
			'23503',
		);
	});

	test('commits wallet, transaction, ledger, Inbox and Outbox atomically; ledger is balanced and immutable', async () => {
		const row = wallet('10.00');
		const transaction = wager(row.id, row.playerId);
		transaction.kind = 'OPENING';
		transaction.status = 'PROCESSED';
		const ledger = orm.em.fork().create(
			WalletLedgerEntryRow,
			{
				walletId: row.id,
				transactionId: transaction.id,
				direction: 'CREDIT',
				currency: 'BRL',
				amount: '10.00',
				balanceBefore: '0.00',
				balanceAfter: '10.00',
			},
			{ persist: false },
		);
		const eventId = uuid();
		await orm.em.fork().transactional(async em => {
			await em.persist([row, transaction]).flush();
			em.persist(ledger);
			em.create(InboxMessageRow, {
				consumerName: 'atomicity',
				messageId: uuid(),
				payloadHash: 'hash',
			});
			em.create(OutboxMessageRow, {
				eventId,
				aggregateId: row.id,
				eventType: 'WalletBalanceChanged',
				eventVersion: 1,
				correlationId: uuid(),
				payload: { eventId },
				occurredAt: new Date(),
			});
		});
		expect(
			await orm.em
				.fork()
				.count(WalletLedgerEntryRow, { transactionId: transaction.id }),
		).toBe(1);
		expect(await orm.em.fork().count(OutboxMessageRow, { eventId })).toBe(
			1,
		);
		const reconstructed = await orm.em.execute<{ balance: string }[]>(
			"select sum(case direction when 'CREDIT' then amount else -amount end)::text as balance from wallet_ledger_entries where wallet_id = ?",
			[row.id],
		);
		expect(reconstructed[0]?.balance).toBe(row.balance);
		expect(
			orm.em
				.fork()
				.insert(WalletLedgerEntryRow, { ...ledger, id: uuid() }),
		).rejects.toMatchObject({ code: '23505' });
		violation(
			'update wallet_ledger_entries set amount = ? where id = ?',
			['11.00', ledger.id],
			'55000',
		);
		violation(
			'delete from wallet_ledger_entries where id = ?',
			[ledger.id],
			'55000',
		);
		violation('truncate wallet_ledger_entries', [], '55000');
		expect(orm.migrator.down()).rejects.toThrow(
			'Cannot revert foundation with confirmed ledger entries',
		);
		expect(
			await orm.em.fork().count(WalletLedgerEntryRow, { id: ledger.id }),
		).toBe(1);
	});

	test('rejects unbalanced ledger and foreign transaction/wallet combinations', async () => {
		const { wallet: row, transaction } = await seed();
		violation(
			"insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after) values (?, ?, ?, 'CREDIT', 'BRL', '10.00', '0.00', '11.00')",
			[uuid(), row.id, transaction.id],
			'23514',
		);
		const other = wallet();
		await orm.em.fork().persist(other).flush();
		violation(
			"insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after) values (?, ?, ?, 'CREDIT', 'BRL', '10.00', '0.00', '10.00')",
			[uuid(), other.id, transaction.id],
			'23503',
		);
	});

	test('rolls back all flushed effects when a later statement fails', async () => {
		const row = wallet('10.00');
		const transaction = wager(row.id, row.playerId);
		const eventId = uuid();
		const messageId = uuid();
		expect(
			orm.em.fork().transactional(async em => {
				await em.persist([row, transaction]).flush();
				em.create(WalletLedgerEntryRow, {
					walletId: row.id,
					transactionId: transaction.id,
					direction: 'CREDIT',
					currency: 'BRL',
					amount: '10.00',
					balanceBefore: '0.00',
					balanceAfter: '10.00',
				});
				em.create(InboxMessageRow, {
					consumerName: 'rollback',
					messageId,
					payloadHash: 'hash',
				});
				em.create(OutboxMessageRow, {
					eventId,
					aggregateId: row.id,
					eventType: 'WalletBalanceChanged',
					eventVersion: 1,
					correlationId: uuid(),
					payload: { eventId },
					occurredAt: new Date(),
				});
				em.create(IdempotencyRecordRow, {
					scope: 'rollback',
					idempotencyKey: transaction.id,
					payloadHash: 'hash',
					transactionId: transaction.id,
				});
				await em.flush();
				await em.execute(
					'update wallets set balance = ? where id = ?',
					['-1.00', row.id],
				);
			}),
		).rejects.toMatchObject({ code: '23514' });
		const em = orm.em.fork();
		expect(await em.count(WalletRow, { id: row.id })).toBe(0);
		expect(
			await em.count(WagerTransactionRow, { id: transaction.id }),
		).toBe(0);
		expect(
			await em.count(WalletLedgerEntryRow, {
				transactionId: transaction.id,
			}),
		).toBe(0);
		expect(await em.count(InboxMessageRow, { messageId })).toBe(0);
		expect(await em.count(OutboxMessageRow, { eventId })).toBe(0);
		expect(
			await em.count(IdempotencyRecordRow, {
				transactionId: transaction.id,
			}),
		).toBe(0);
	});

	test('isolates identity maps and uncommitted transactions between persistence contexts', async () => {
		const row = wallet();
		await orm.em.fork().persist(row).flush();
		const first = orm.em.fork();
		const second = orm.em.fork();
		const a = await first.findOneOrFail(WalletRow, row.id);
		const b = await second.findOneOrFail(WalletRow, row.id);
		expect(a).not.toBe(b);
		await first.begin();
		try {
			a.balance = '99.00';
			await first.flush();
			await second.refresh(b);
			expect(b.balance).toBe('100.00');
		} finally {
			await first.rollback();
		}
		expect(
			(await orm.em.fork().findOneOrFail(WalletRow, row.id)).balance,
		).toBe('100.00');
	});

	test('locks a wallet across independent Bun processes while another wallet remains available', async () => {
		const first = wallet();
		const second = wallet();
		await orm.em.fork().persist([first, second]).flush();
		await orm.em.fork().transactional(async em => {
			await em.findOneOrFail(WalletRow, first.id, {
				lockMode: LockMode.PESSIMISTIC_WRITE,
			});
			const [same, other] = await Promise.all(
				[first, second].map(row =>
					command(
						[
							process.execPath,
							'test/support/wallet-lock.ts',
							row.id,
						],
						database().env,
					),
				),
			);
			const sameResult: unknown = JSON.parse(same ?? 'null');
			const otherResult: unknown = JSON.parse(other ?? 'null');
			expect(sameResult).toMatchObject({ result: 'locked' });
			expect(otherResult).toMatchObject({ result: 'acquired' });
			console.info('Wallet lock evidence:', {
				holderPid: process.pid,
				same: sameResult,
				other: otherResult,
			});
		});
		const released: unknown = JSON.parse(
			await command(
				[process.execPath, 'test/support/wallet-lock.ts', first.id],
				database().env,
			),
		);
		expect(released).toMatchObject({ result: 'acquired' });
	}, 15_000);
});
