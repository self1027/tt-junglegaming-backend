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

test('replay uses historical balance; different payload conflicts; different providers remain independent', async () => {
	const wallet = await opened();
	const command = input(wallet);
	const original = await useCase.execute(command);
	await useCase.execute(input(wallet, { kind: 'WIN' }));
	const events = await orm.em
		.fork()
		.find(OutboxMessageRow, { correlationId: original.transactionId });
	expect(await useCase.execute(command)).toEqual({
		...original,
		idempotentReplay: true,
	});
	expect(useCase.execute({ ...command, kind: 'WIN' })).rejects.toMatchObject({
		code: 'IDEMPOTENCY_CONFLICT',
	});
	expect(
		useCase.execute({ ...command, idempotencyKey: 'new' }),
	).rejects.toMatchObject({
		code: 'EXTERNAL_TRANSACTION_CONFLICT',
		samePayload: true,
	});
	expect(
		useCase.execute({
			...command,
			idempotencyKey: 'divergent',
			kind: 'WIN',
		}),
	).rejects.toMatchObject({
		code: 'EXTERNAL_TRANSACTION_CONFLICT',
		samePayload: false,
	});
	expect(
		await useCase.execute({ ...command, providerId: 'another-provider' }),
	).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
	await inspect(
		wallet,
		'90.00',
		4,
		['PROCESSED', 'PROCESSED', 'PROCESSED'],
		4,
	);
	expect(
		await orm.em.fork().count(IdempotencyRecordRow, {
			idempotencyKey: { $in: ['new', 'divergent'] },
		}),
	).toBe(0);
	expect(
		await orm.em
			.fork()
			.find(OutboxMessageRow, { correlationId: original.transactionId }),
	).toEqual(events);
});

test.each([
	['BET', 'REFUND'],
	['BET', 'ROLLBACK'],
	['WIN', 'ROLLBACK'],
] as const)(
	'SQL %s followed by %s has exact inverse ledger',
	async (kind, reversalKind) => {
		const wallet = await opened();
		const original = input(wallet, { kind });
		await useCase.execute(original);
		const reversal = input(wallet, {
			kind: reversalKind,
			referenceExternalTransactionId: original.externalTransactionId,
		});
		const result = await useCase.execute(reversal);
		expect(result).toMatchObject({
			status: 'PROCESSED',
			balance: { amount: '100.00' },
		});
		expect(await useCase.execute(reversal)).toMatchObject({
			status: 'PROCESSED',
			idempotentReplay: true,
		});
		await inspect(wallet, '100.00', 3, ['PROCESSED', 'PROCESSED'], 3);
		const entry = await orm.em.fork().findOneOrFail(WalletLedgerEntryRow, {
			transactionId: result.transactionId,
		});
		expect(entry).toMatchObject({
			direction: kind === 'WIN' ? 'DEBIT' : 'CREDIT',
			amount: '10.00',
			balanceAfter: '100.00',
		});
	},
);

test('SQL rollback of refund permits the unused direct modality and never resets same-kind uniqueness', async () => {
	const wallet = await opened();
	const bet = input(wallet);
	await useCase.execute(bet);
	const refund = input(wallet, {
		kind: 'REFUND',
		referenceExternalTransactionId: bet.externalTransactionId,
	});
	await useCase.execute(refund);
	await useCase.execute(
		input(wallet, {
			kind: 'ROLLBACK',
			referenceExternalTransactionId: refund.externalTransactionId,
		}),
	);
	expect(
		await useCase.execute(
			input(wallet, {
				kind: 'ROLLBACK',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
		),
	).toMatchObject({
		status: 'PROCESSED',
		balance: { amount: '100.00' },
	});
	expect(
		await useCase.execute(
			input(wallet, {
				kind: 'REFUND',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
		),
	).toMatchObject({ status: 'REJECTED', failureCode: 'DUPLICATE_REVERSAL' });
	await inspect(
		wallet,
		'100.00',
		5,
		['PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'REJECTED'],
		5,
	);
});

test('SQL rollback first then refund is rejected without cumulative credit', async () => {
	const wallet = await opened();
	const bet = input(wallet);
	await useCase.execute(bet);
	await useCase.execute(
		input(wallet, {
			kind: 'ROLLBACK',
			referenceExternalTransactionId: bet.externalTransactionId,
		}),
	);
	expect(
		await useCase.execute(
			input(wallet, {
				kind: 'REFUND',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
	});
	await inspect(
		wallet,
		'100.00',
		3,
		['PROCESSED', 'PROCESSED', 'REJECTED'],
		3,
	);
});

test.each(['PENDING', 'PENDING_REFERENCE', 'REJECTED', 'FAILED'] as const)(
	'SQL reference %s is durable and has no reversal effects',
	async status => {
		const wallet = await opened();
		const original = input(wallet);
		const reference = WagerTransaction.rehydrate({
			...original,
			id: crypto.randomUUID(),
			walletId: wallet.id,
			money: money('10.00'),
			payloadHash: 'seeded',
			createdAt: changedAt,
			status,
			referenceExternalTransactionId:
				status === 'PENDING_REFERENCE' ? 'older' : undefined,
			...(status === 'REJECTED' || status === 'FAILED'
				? { failureCode: 'SEEDED' }
				: {}),
		});
		await uow.execute(context => context.transactions.insert(reference));
		const result = await useCase.execute(
			input(wallet, {
				kind: 'REFUND',
				referenceExternalTransactionId: original.externalTransactionId,
			}),
		);
		if (status === 'REJECTED' || status === 'FAILED')
			expect(result).toMatchObject({
				status: 'REJECTED',
				failureCode: 'REFERENCE_TERMINAL_INELIGIBLE',
			});
		else
			expect(result).toMatchObject({
				status: 'PENDING',
				pendingReference: {
					reason: 'NOT_PROCESSED',
					transactionId: reference.id,
					status,
				},
			});
		await uow.execute(async context => {
			expect((await context.wallets.findById(wallet.id))?.version).toBe(
				1,
			);
			expect(await context.ledger.findByWalletId(wallet.id)).toHaveLength(
				1,
			);
			expect(
				(await context.transactions.findById(result.transactionId))
					?.status,
			).toBe(result.status);
		});
		expect(
			await orm.em.fork().count(IdempotencyRecordRow, {
				transactionId: result.transactionId,
				status: 'COMPLETED',
			}),
		).toBe(1);
		expect(
			await orm.em.fork().count(OutboxMessageRow, {
				correlationId: result.transactionId,
			}),
		).toBe(status === 'REJECTED' || status === 'FAILED' ? 1 : 0);
	},
);

test('SQL insufficient rollback rejects without financial change or version increment', async () => {
	const wallet = await opened();
	const win = input(wallet, { kind: 'WIN' });
	await useCase.execute(win);
	await useCase.execute(
		input(wallet, { amount: { amount: '110.00', currency: 'BRL' } }),
	);
	expect(
		await useCase.execute(
			input(wallet, {
				kind: 'ROLLBACK',
				referenceExternalTransactionId: win.externalTransactionId,
			}),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'REVERSAL_INSUFFICIENT_BALANCE',
	});
	await inspect(wallet, '0.00', 3, ['PROCESSED', 'PROCESSED', 'REJECTED'], 3);
});

test('malformed player identity cannot debit a different UTF-8 identity in PostgreSQL', async () => {
	const wallet = WalletEntity.create({
		id: crypto.randomUUID(),
		playerId: '\ufffd',
		currency: 'BRL',
		createdAt: changedAt,
	});
	await uow.execute(context => context.wallets.insert(wallet));
	await useCase.execute(
		input(wallet, {
			kind: 'WIN',
			amount: { amount: '100.00', currency: 'BRL' },
		}),
	);
	expect(
		useCase.execute(input(wallet, { playerId: '\ud800' })),
	).rejects.toThrow('Unicode');
	await inspect(wallet, '100.00', 2, ['PROCESSED'], 1);
});

async function blocked(pids: number[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const rows = await orm.em.execute<{ application_name: string }[]>(
			"select application_name from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
		);
		if (
			pids.every(pid =>
				rows.some(
					row => row.application_name === `wager-test-${String(pid)}`,
				),
			)
		) {
			console.log(JSON.stringify({ blockedPids: pids }));
			return;
		}
		await Bun.sleep(10);
	}
	throw new Error('Bun contenders never reached SQL lock wait');
}
type Child = ReturnType<typeof wagerChild>;
function child(command: ProcessWagerCommand, mode = 'normal'): Child {
	if (postgres === undefined) throw new Error('Missing PostgreSQL');
	return wagerChild(postgres.env, command, mode);
}
async function ready(children: Child[]): Promise<void> {
	expect(await Promise.all(children.map(c => c.next()))).toEqual(
		children.map(() => 'ready'),
	);
}
async function close(children: Child[]): Promise<void> {
	await Promise.all(children.map(c => c.close()));
}

async function compete(children: Child[]): Promise<string[]> {
	await ready(children);
	const [holder, ...contenders] = children;
	if (holder === undefined) throw new Error('Missing holder');
	await holder.signal();
	expect(await holder.next()).toBe('before-commit');
	await Promise.all(contenders.map(c => c.signal()));
	await blocked(contenders.map(c => c.pid));
	await holder.signal();
	return Promise.all(children.map(c => c.next()));
}

test('three independent Bun processes serialize BETs on one wallet without lost updates', async () => {
	const wallet = await opened();
	const children = [
		child(input(wallet), 'hold-commit'),
		child(input(wallet)),
		child(input(wallet)),
	];
	try {
		const results = await compete(children);
		expect(results).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);
		await inspect(
			wallet,
			'70.00',
			4,
			['PROCESSED', 'PROCESSED', 'PROCESSED'],
			4,
		);
	} finally {
		await close(children);
	}
}, 20_000);

test('distinct wallets commit in parallel while a third process holds its wallet lock', async () => {
	const wallets = await Promise.all([opened(), opened(), opened()]);
	const children = wallets.map((wallet, i) =>
		child(input(wallet), i === 0 ? 'hold-commit' : 'normal'),
	);
	try {
		await ready(children);
		const holder = children[0];
		if (holder === undefined) throw new Error('Missing holder');
		await holder.signal();
		expect(await holder.next()).toBe('before-commit');
		const others = children.slice(1);
		await Promise.all(others.map(c => c.signal()));
		expect(await Promise.all(others.map(c => c.next()))).toEqual([
			'PROCESSED',
			'PROCESSED',
		]);
		await holder.signal();
		expect(await holder.next()).toBe('PROCESSED');
		for (const wallet of wallets)
			await inspect(wallet, '90.00', 2, ['PROCESSED'], 2);
	} finally {
		await close(children);
	}
}, 20_000);

test('rollback releases SQL locks to two independent 80.00 BETs, exactly one succeeds', async () => {
	const wallet = await opened();
	const debit = (): ProcessWagerCommand =>
		input(wallet, { amount: { amount: '80.00', currency: 'BRL' } });
	const held = input(wallet);
	const children = [
		child(held, 'hold-rollback'),
		child(debit()),
		child(debit()),
	];
	try {
		const results = await compete(children);
		expect(results[0]).toBe('rolled-back');
		expect(results.slice(1).sort()).toEqual(['PROCESSED', 'REJECTED']);
		await inspect(wallet, '20.00', 2, ['PROCESSED', 'REJECTED'], 2);
		const debitEntries = await orm.em.fork().find(WalletLedgerEntryRow, {
			walletId: wallet.id,
			direction: 'DEBIT',
		});
		expect(debitEntries.map(e => e.amount)).toEqual(['80.00']);
		expect(
			await orm.em.fork().count(IdempotencyRecordRow, {
				idempotencyKey: held.idempotencyKey,
			}),
		).toBe(0);
	} finally {
		await close(children);
	}
}, 20_000);

test.each(['same-key', 'external-identity'] as const)(
	'three processes competing for %s apply a single debit',
	async scenario => {
		const wallet = await opened();
		const command = input(wallet);
		const children = [0, 1, 2].map(i =>
			child(
				{
					...command,
					idempotencyKey:
						scenario === 'same-key'
							? command.idempotencyKey
							: `${command.idempotencyKey}-${String(i)}`,
				},
				i === 0 ? 'hold-commit' : 'normal',
			),
		);
		try {
			const results = await compete(children);
			expect(results).toEqual(
				scenario === 'same-key'
					? ['PROCESSED', 'REPLAY', 'REPLAY']
					: [
							'PROCESSED',
							'EXTERNAL_TRANSACTION_CONFLICT',
							'EXTERNAL_TRANSACTION_CONFLICT',
						],
			);
			await inspect(wallet, '90.00', 2, ['PROCESSED'], 2);
		} finally {
			await close(children);
		}
	},
	20_000,
);

test.each(['cross-kind', 'same-kind'] as const)(
	'three processes cannot duplicate reversals: %s',
	async scenario => {
		const wallet = await opened();
		const bet = input(wallet);
		await useCase.execute(bet);
		const refund = input(wallet, {
			kind: 'REFUND',
			referenceExternalTransactionId: bet.externalTransactionId,
		});
		const children = [
			child(refund, 'hold-commit'),
			child(
				input(wallet, {
					kind: scenario === 'cross-kind' ? 'ROLLBACK' : 'REFUND',
					referenceExternalTransactionId: bet.externalTransactionId,
				}),
			),
			child(input(wallet, { kind: 'LOSS' })),
		];
		try {
			const results = await compete(children);
			expect(results).toEqual(['PROCESSED', 'REJECTED', 'PROCESSED']);
			await inspect(
				wallet,
				'100.00',
				3,
				['PROCESSED', 'PROCESSED', 'REJECTED', 'PROCESSED'],
				3,
			);
			const rejected = await orm.em
				.fork()
				.findOneOrFail(WagerTransactionRow, {
					walletId: wallet.id,
					status: 'REJECTED',
				});
			expect(rejected.failureCode).toBe(
				scenario === 'cross-kind'
					? 'CUMULATIVE_REVERSAL_NOT_ALLOWED'
					: 'DUPLICATE_REVERSAL',
			);
		} finally {
			await close(children);
		}
	},
	20_000,
);

test('original and reversal coordinate through wallet lock without reference lock inversion', async () => {
	const wallet = await opened();
	const bet = input(wallet);
	const children = [
		child(bet, 'hold-commit'),
		child(
			input(wallet, {
				kind: 'REFUND',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
		),
		child(input(wallet, { kind: 'LOSS' })),
	];
	try {
		const results = await compete(children);
		expect(results).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);
		await inspect(
			wallet,
			'100.00',
			3,
			['PROCESSED', 'PROCESSED', 'PROCESSED'],
			3,
		);
	} finally {
		await close(children);
	}
}, 20_000);

test.each(['crash-before-commit', 'crash-after-commit'] as const)(
	'%s recovers through a new process and durable idempotency',
	async mode => {
		const wallet = await opened();
		const command = input(wallet);
		const holder = child(command, mode);
		const others = [child(command), child(command)];
		const children = [holder, ...others];
		try {
			await ready(children);
			await holder.signal();
			expect(await holder.next()).toBe(
				mode === 'crash-before-commit'
					? 'before-commit'
					: 'committed-before-response',
			);
			const committedEvents = await orm.em.fork().find(OutboxMessageRow, {
				payload: { data: { walletId: wallet.id } },
			});
			expect(committedEvents).toHaveLength(
				mode === 'crash-before-commit' ? 0 : 2,
			);
			if (mode === 'crash-before-commit')
				await inspect(wallet, '100.00', 1, [], 1);
			if (mode === 'crash-before-commit') {
				await Promise.all(others.map(c => c.signal()));
				await blocked(others.map(c => c.pid));
			}
			await holder.kill();
			if (mode === 'crash-after-commit') {
				const reader = child(command, 'read-outbox');
				try {
					expect(await reader.next()).toBe('ready');
					await reader.signal();
					const output = await reader.next();
					expect(output.startsWith('OUTBOX:')).toBe(true);
					const rows: unknown = JSON.parse(
						output.slice('OUTBOX:'.length),
					);
					expect(rows).toHaveLength(2);
					expect(rows).toEqual(
						expect.arrayContaining(
							committedEvents.map(event => ({
								event_id: event.eventId,
								event_type: event.eventType,
								event_version: 1,
								status: 'PENDING',
							})),
						),
					);
					expect(await reader.next()).toBe('REPLAY');
				} finally {
					await reader.close();
				}
				await Promise.all(others.map(c => c.signal()));
			}
			const results = (
				await Promise.all(others.map(c => c.next()))
			).sort();
			expect(results).toEqual(
				mode === 'crash-before-commit'
					? ['PROCESSED', 'REPLAY']
					: ['REPLAY', 'REPLAY'],
			);
			await inspect(wallet, '90.00', 2, ['PROCESSED'], 2);
			if (mode === 'crash-after-commit')
				expect(
					await orm.em.fork().find(OutboxMessageRow, {
						payload: { data: { walletId: wallet.id } },
					}),
				).toEqual(committedEvents);
			expect(await useCase.execute(command)).toMatchObject({
				status: 'PROCESSED',
				idempotentReplay: true,
				balance: { amount: '90.00' },
			});
		} finally {
			await close(children);
		}
	},
	20_000,
);

test('fifty duplicate submissions across three Bun pools debit once', async () => {
	const wallet = await opened();
	const command = input(wallet);
	const children = [
		child(command, 'batch-17-hold'),
		child(command, 'batch-17'),
		child(command, 'batch-16'),
	];
	try {
		const results = await compete(children);
		expect(results).toEqual(['BATCH:1:16', 'BATCH:0:17', 'BATCH:0:16']);
		await inspect(wallet, '90.00', 2, ['PROCESSED'], 2);
	} finally {
		await close(children);
	}
}, 20_000);

test('reversal winning the wallet lock remains durably pending when the original subsequently commits', async () => {
	const wallet = await opened();
	const bet = input(wallet);
	const reversal = input(wallet, {
		kind: 'REFUND',
		referenceExternalTransactionId: bet.externalTransactionId,
	});
	const children = [
		child(reversal, 'hold-commit'),
		child(bet),
		child(input(wallet, { kind: 'LOSS' })),
	];
	try {
		const results = await compete(children);
		expect(results).toEqual([
			'PENDING_REFERENCE',
			'PROCESSED',
			'PROCESSED',
		]);
		expect(await useCase.execute(reversal)).toMatchObject({
			status: 'PENDING_REFERENCE',
			idempotentReplay: true,
			pendingReference: { reason: 'NOT_FOUND' },
		});
		await inspect(
			wallet,
			'90.00',
			2,
			['PENDING_REFERENCE', 'PROCESSED', 'PROCESSED'],
			2,
		);
	} finally {
		await close(children);
	}
}, 20_000);
