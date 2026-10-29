import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { createProcessWagerUseCase } from '../src/bootstrap/wagering.js';
import {
	Money,
	Wallet as WalletEntity,
} from '../src/modules/financial/public/index.js';
import type { Wallet } from '../src/modules/financial/public/index.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import type { ProcessWagerCommand } from '../src/modules/wagering/public/process-wager.js';
import type { WageringUnitOfWork } from '../src/modules/wagering/public/persistence.js';
import type { WagerTransactionStatus } from '../src/modules/wagering/public/index.js';
import {
	OutboxMessageRow,
	IdempotencyRecordRow,
	WagerTransactionRow,
	WalletLedgerEntryRow,
} from '../src/platform/persistence/models.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { openWallet } from './support/financial.js';
import { WagerTransaction } from '../src/modules/wagering/public/index.js';
import { money, changedAt } from './support/financial.js';
import { wagerChild } from './support/wager-child.js';
import { WagerTransactionProcessed } from '../src/modules/wagering/public/events.js';
import type { OutboxRepository } from '../src/modules/wagering/public/events.js';

let postgres: TestPostgres | undefined;
let orm: MikroORM;
let uow: WageringUnitOfWork;
let useCase: ProcessWagerUseCase;
beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await orm.migrator.up();
	uow = createUnitOfWork(orm);
	useCase = createProcessWagerUseCase(orm);
}, 90_000);
afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		await postgres?.close();
	}
}, 30_000);

function input(
	wallet: Wallet,
	overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
	const id = crypto.randomUUID();
	return {
		providerId: 'provider',
		playerId: wallet.playerId,
		externalTransactionId: id,
		idempotencyKey: id,
		roundId: 'round',
		gameId: 'game',
		kind: 'BET',
		amount: { amount: '10.00', currency: 'BRL' },
		...overrides,
	};
}
async function opened(): Promise<Wallet> {
	return uow.execute(context => openWallet(context));
}

async function inspect(
	wallet: Wallet,
	balance: string,
	version: number,
	statuses: WagerTransactionStatus[],
	ledgerCount: number,
): Promise<void> {
	await uow.execute(async context => {
		const restored = await context.wallets.findById(wallet.id);
		expect(restored?.balance.toProps().amount).toBe(balance);
		expect(restored?.version).toBe(version);
		const entries = await context.ledger.findByWalletId(wallet.id);
		expect(entries).toHaveLength(ledgerCount);
		let total = Money.zero('BRL');
		for (const entry of entries)
			total =
				entry.direction === 'CREDIT'
					? total.add(entry.amount)
					: total.subtract(entry.amount);
		expect(total.toProps().amount).toBe(balance);
		for (const entry of entries)
			expect(entry.amount.isPositive()).toBe(true);
	});
	const transactions = await orm.em.fork().find(WagerTransactionRow, {
		walletId: wallet.id,
		kind: { $ne: 'OPENING' },
	});
	expect(transactions.map(t => t.status).sort()).toEqual(
		[...statuses].sort(),
	);
	const records = await orm.em.fork().find(IdempotencyRecordRow, {
		transactionId: { $in: transactions.map(t => t.id) },
	});
	expect(records).toHaveLength(transactions.length);
	for (const record of records) {
		expect(record.status).toBe('COMPLETED');
		expect(record.originalResult).toMatchObject({
			transactionId: record.transactionId,
		});
	}
	const rows = await orm.em.fork().find(OutboxMessageRow, {
		payload: { data: { walletId: wallet.id } },
	});
	const entries = await orm.em.fork().find(WalletLedgerEntryRow, {
		walletId: wallet.id,
		transactionId: { $in: transactions.map(t => t.id) },
	});
	const expected =
		transactions.filter(
			t => t.status !== 'PENDING' && t.status !== 'FAILED',
		).length + entries.length;
	expect(rows).toHaveLength(expected);
	expect(new Set(rows.map(row => row.eventId)).size).toBe(expected);
	for (const transaction of transactions) {
		const expectedType = new Map<WagerTransactionStatus, string>([
			['PROCESSED', 'WagerTransactionProcessed'],
			['REJECTED', 'WagerTransactionRejected'],
			['PENDING_REFERENCE', 'WagerTransactionPendingReference'],
		]).get(transaction.status);
		const facts = rows.filter(row => row.aggregateId === transaction.id);
		expect(facts).toHaveLength(expectedType === undefined ? 0 : 1);
		if (expectedType !== undefined)
			expect(facts[0]?.payload).toMatchObject({
				eventType: expectedType,
				version: 1,
				aggregateId: transaction.id,
				data: {
					transactionId: transaction.id,
					providerId: transaction.providerId,
					externalTransactionId: transaction.externalTransactionId,
					kind: transaction.kind,
					status: transaction.status,
					money: {
						amount: transaction.amount,
						currency: transaction.currency,
					},
				},
			});
	}
	for (const entry of entries) {
		const fact = rows.find(
			row =>
				row.eventType === 'WalletBalanceChanged' &&
				row.correlationId === entry.transactionId,
		);
		expect(fact?.payload).toMatchObject({
			aggregateId: wallet.id,
			data: {
				walletId: wallet.id,
				transactionId: entry.transactionId,
				direction: entry.direction,
				money: { amount: entry.amount, currency: entry.currency },
				balanceBefore: {
					amount: entry.balanceBefore,
					currency: entry.currency,
				},
				balanceAfter: {
					amount: entry.balanceAfter,
					currency: entry.currency,
				},
			},
		});
	}
	for (const row of rows) {
		expect(row).toMatchObject({
			status: 'PENDING',
			attempts: 0,
			publishedAt: null,
			lastError: null,
			eventVersion: 1,
			causationId: null,
		});
		expect(row.nextAttemptAt.getTime()).toBe(row.createdAt.getTime());
		expect(row.payload).toMatchObject({
			eventId: row.eventId,
			eventType: row.eventType,
			aggregateId: row.aggregateId,
			correlationId: row.correlationId,
			occurredAt: row.occurredAt.toISOString(),
			version: row.eventVersion,
		});
		expect(row.payload).not.toHaveProperty('causationId');
	}
}

test.each([
	['BET', '90.00', 2, 2],
	['WIN', '110.00', 2, 2],
	['LOSS', '100.00', 1, 1],
] as const)(
	'atomic %s persists wallet, wager, ledger and idempotency together',
	async (kind, balance, version, ledger) => {
		const wallet = await opened();
		const result = await useCase.execute(input(wallet, { kind }));
		expect(result).toMatchObject({
			status: 'PROCESSED',
			balance: { amount: balance },
		});
		await inspect(wallet, balance, version, ['PROCESSED'], ledger);
		const entries = await orm.em.fork().find(WalletLedgerEntryRow, {
			transactionId: result.transactionId,
		});
		if (kind !== 'LOSS') expect(entries[0]?.amount).toBe('10.00');
	},
);

test('rejection and durable missing reference have no effects; pending replay never retries business', async () => {
	const wallet = await opened();
	expect(
		await useCase.execute(
			input(wallet, { amount: { amount: '101.00', currency: 'BRL' } }),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'BET_INSUFFICIENT_BALANCE',
	});
	const pending = input(wallet, {
		kind: 'REFUND',
		referenceExternalTransactionId: 'missing',
	});
	const accepted = await useCase.execute(pending);
	expect(accepted).toMatchObject({
		status: 'PENDING_REFERENCE',
		pendingReference: { reason: 'NOT_FOUND' },
	});
	expect(await useCase.execute(pending)).toEqual({
		...accepted,
		idempotentReplay: true,
	});
	await inspect(wallet, '100.00', 1, ['REJECTED', 'PENDING_REFERENCE'], 1);
});

test('Outbox port preserves explicit metadata and exact JSONB money; closed sessions reject append', async () => {
	const event = WagerTransactionProcessed.create({
		eventId: crypto.randomUUID(),
		aggregateId: '0192f298-345e-7e38-af88-e43f851a819d',
		correlationId: 'operation-correlation',
		causationId: 'previous-event',
		occurredAt: changedAt,
		data: {
			transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
			walletId: crypto.randomUUID(),
			providerId: 'provider',
			playerId: 'player',
			externalTransactionId: 'external',
			kind: 'LOSS',
			status: 'PROCESSED',
			money: { amount: '9007199254740993.01', currency: 'BRL' },
		},
	});
	let port: OutboxRepository | undefined;
	await uow.execute(async context => {
		port = context.outbox;
		await context.outbox.append([event]);
	});
	if (postgres === undefined) throw new Error('Missing PostgreSQL');
	const reader = await testOrm(postgres);
	try {
		const restored = await reader.em
			.fork()
			.findOneOrFail(OutboxMessageRow, { eventId: event.eventId });
		expect(restored.payload).toEqual(event.toJSON());
		expect(restored).toMatchObject({
			correlationId: 'operation-correlation',
			causationId: 'previous-event',
			status: 'PENDING',
		});
		expect(restored.occurredAt).toEqual(changedAt);
	} finally {
		await reader.close(true);
	}
	if (port === undefined) throw new Error('Missing port');
	expect(port.append([event])).rejects.toThrow('not active');
});

test('duplicate eventId rolls back financial processing and every event in its SQL transaction', async () => {
	const wallet = await opened();
	const command = input(wallet);
	let captured: OutboxRepository | undefined;
	const duplicate: WageringUnitOfWork = {
		execute: work =>
			uow.execute(context =>
				work({
					...context,
					outbox: {
						append: async events => {
							captured = context.outbox;
							await context.outbox.append(events);
							await context.outbox.append(events);
						},
					},
				}),
			),
	};
	expect(
		new ProcessWagerUseCase(duplicate).execute(command),
	).rejects.toMatchObject({ code: '23505' });
	await inspect(wallet, '100.00', 1, [], 1);
	expect(
		await orm.em.fork().count(IdempotencyRecordRow, {
			idempotencyKey: command.idempotencyKey,
		}),
	).toBe(0);
	if (captured === undefined) throw new Error('Missing failed context');
	expect(captured.append([])).rejects.toThrow('not active');
	expect(await useCase.execute(command)).toMatchObject({
		status: 'PROCESSED',
		idempotentReplay: false,
	});
	await inspect(wallet, '90.00', 2, ['PROCESSED'], 2);
});

test('SQL JSONB preserves cents above 53 bits in processing and wallet facts', async () => {
	const wallet = await uow.execute(context =>
		openWallet(context, '9007199254740993.01'),
	);
	await useCase.execute(
		input(wallet, { amount: { amount: '0.01', currency: 'BRL' } }),
	);
	await inspect(wallet, '9007199254740993.00', 2, ['PROCESSED'], 2);
	const fact = await orm.em
		.fork()
		.findOneOrFail(OutboxMessageRow, { aggregateId: wallet.id });
	expect(fact.payload).toMatchObject({
		data: {
			balanceBefore: { amount: '9007199254740993.01' },
			balanceAfter: { amount: '9007199254740993.00' },
			money: { amount: '0.01' },
			walletVersion: 2,
		},
	});
});

test.each(['ledger', 'wallet', 'idempotency', 'wager', 'outbox'] as const)(
	'rollback on SQL %s failure leaves no claim or partial effects and allows retry',
	async fault => {
		const wallet = await opened();
		const command = input(wallet);
		const target = {
			outbox: {
				table: 'outbox_messages',
				event: 'insert',
				match: `new.aggregate_id = '${wallet.id}'::uuid and new.event_type = 'WalletBalanceChanged'`,
			},
			ledger: {
				table: 'wallet_ledger_entries',
				event: 'insert',
				match: `new.wallet_id = '${wallet.id}'::uuid`,
			},
			wallet: {
				table: 'wallets',
				event: 'update',
				match: `new.id = '${wallet.id}'::uuid`,
			},
			idempotency: {
				table: 'idempotency_records',
				event: 'update',
				match: `new.idempotency_key = '${command.idempotencyKey}'`,
			},
			wager: {
				table: 'wager_transactions',
				event: 'insert',
				match: `new.external_transaction_id = '${command.externalTransactionId}'`,
			},
		}[fault];
		const priorEvents =
			fault === 'idempotency'
				? "if (select count(*) from outbox_messages where correlation_id = new.transaction_id::text) <> 2 then raise exception 'Expected events before idempotency failure' using errcode = 'P0001'; end if;"
				: fault === 'outbox'
					? "if (select count(*) from outbox_messages where correlation_id = new.correlation_id) <> 1 then raise exception 'Expected first event before second insert failure' using errcode = 'P0001'; end if;"
					: '';
		await orm.em.execute(
			`create function test_wager_fault() returns trigger language plpgsql as $$ begin if ${target.match} then ${priorEvents} raise exception 'injected failure' using errcode = '23514'; end if; return new; end; $$`,
		);
		await orm.em.execute(
			`create trigger test_wager_fault before ${target.event} on ${target.table} for each row execute function test_wager_fault()`,
		);
		try {
			if (fault === 'outbox') {
				const worker = child(command, 'sql-fault');
				try {
					expect(await worker.next()).toBe('ready');
					await worker.signal();
					expect(await worker.next()).toBe('SQL:23514');
				} finally {
					await worker.close();
				}
				await inspect(wallet, '100.00', 1, [], 1);
			}
			expect(useCase.execute(command)).rejects.toMatchObject({
				code: '23514',
			});
			await inspect(wallet, '100.00', 1, [], 1);
			expect(
				await orm.em.fork().count(IdempotencyRecordRow, {
					idempotencyKey: command.idempotencyKey,
				}),
			).toBe(0);
		} finally {
			await orm.em.execute(
				`drop trigger test_wager_fault on ${target.table}`,
			);
			await orm.em.execute('drop function test_wager_fault()');
		}
		expect(await useCase.execute(command)).toMatchObject({
			status: 'PROCESSED',
			idempotentReplay: false,
		});
		await inspect(wallet, '90.00', 2, ['PROCESSED'], 2);
	},
);
