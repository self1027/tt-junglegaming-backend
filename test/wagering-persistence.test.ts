import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { WagerTransaction } from '../src/modules/wagering/public/index.js';
import type { CreateWagerTransactionProps } from '../src/modules/wagering/public/index.js';
import type { Wallet } from '../src/modules/financial/public/index.js';
import type { WageringUnitOfWork } from '../src/modules/wagering/public/persistence.js';
import { money, openWallet, changedAt } from './support/financial.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';

let postgres: TestPostgres | undefined;
let orm: MikroORM;
let uow: WageringUnitOfWork;
beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await orm.migrator.up();
	uow = createUnitOfWork(orm);
}, 90_000);
afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		await postgres?.close();
	}
}, 30_000);

function wager(
	wallet: Wallet,
	overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
	return WagerTransaction.create({
		id: crypto.randomUUID(),
		providerId: 'provider',
		externalTransactionId: crypto.randomUUID(),
		idempotencyKey: crypto.randomUUID(),
		payloadHash: 'hash',
		walletId: wallet.id,
		playerId: wallet.playerId,
		roundId: 'round',
		gameId: 'game',
		kind: 'BET',
		money: money('10.00'),
		createdAt: changedAt,
		...overrides,
	});
}

test('rehydrates every external state and keeps retry metadata outside domain', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	for (const status of [
		'PENDING',
		'PENDING_REFERENCE',
		'PROCESSED',
		'REJECTED',
		'FAILED',
	] as const) {
		const transaction = wager(wallet, {
			kind: 'WIN',
			money: money('9007199254740993.01'),
			...(status === 'PENDING_REFERENCE'
				? { referenceExternalTransactionId: 'absent' }
				: {}),
		});
		if (status === 'PENDING_REFERENCE') transaction.markPendingReference();
		if (status === 'PROCESSED') transaction.markProcessed(changedAt);
		if (status === 'REJECTED') transaction.reject('TEST_REJECTED');
		if (status === 'FAILED') transaction.fail('TEST_PERMANENT');
		await uow.execute(context => context.transactions.insert(transaction));
		await uow.execute(async context => {
			const restored = await context.transactions.findById(
				transaction.id,
			);
			expect(restored?.status).toBe(status);
			expect(restored?.money.toProps().amount).toBe(
				'9007199254740993.01',
			);
			expect(restored?.failureCode).toBe(transaction.failureCode);
			expect(restored?.processedAt).toEqual(transaction.processedAt);
			expect(
				(
					await context.transactions.findByExternalIdentity(
						'provider',
						transaction.externalTransactionId,
					)
				)?.id,
			).toBe(transaction.id);
		});
	}
});

test('reserves and completes idempotency with the original result, rollback releases the claim', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const transaction = wager(wallet, {
		kind: 'LOSS',
		money: money('0.00'),
	});
	transaction.markProcessed(changedAt);
	const scope = crypto.randomUUID();
	const key = transaction.idempotencyKey;
	const result = {
		transactionId: transaction.id,
		externalTransactionId: transaction.externalTransactionId,
		walletId: wallet.id,
		status: 'PROCESSED' as const,
		balance: money('100.00').toProps(),
		idempotentReplay: false,
	};
	const failure = new Error('rollback');
	expect(
		uow.execute(async context => {
			expect(await context.idempotency.claim(scope, key, 'hash')).toEqual(
				{ type: 'CLAIMED' },
			);
			throw failure;
		}),
	).rejects.toBe(failure);
	await uow.execute(async context => {
		expect(await context.idempotency.claim(scope, key, 'hash')).toEqual({
			type: 'CLAIMED',
		});
		await context.transactions.insert(transaction);
		await context.idempotency.complete(scope, key, 'hash', result);
	});
	await uow.execute(async context => {
		expect(await context.idempotency.claim(scope, key, 'other')).toEqual({
			type: 'EXISTING',
			payloadHash: 'hash',
			result,
		});
	});
});

test('SQL forbids cross-kind processed reversals while rejected attempts remain auditable; migration down/up keeps history', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const make = (
		kind: 'BET' | 'REFUND' | 'ROLLBACK',
		reference?: string,
	): WagerTransaction =>
		wager(wallet, {
			kind,
			referenceExternalTransactionId: reference,
		});
	const bet = make('BET');
	bet.markProcessed(changedAt);
	await uow.execute(context => context.transactions.insert(bet));
	const refund = make('REFUND', bet.externalTransactionId);
	refund.markProcessed(changedAt, {
		transaction: bet,
		processedReversalKinds: [],
	});
	await uow.execute(context => context.transactions.insert(refund));
	await orm.migrator.down({ to: 'Migration202610280001' });
	expect(
		await orm.em.execute('select id from wager_transactions where id = ?', [
			refund.id,
		]),
	).toHaveLength(1);
	await orm.migrator.up();
	expect(
		await uow.execute(context => context.transactions.findById(refund.id)),
	).toBeDefined();
	const rollback = make('ROLLBACK', bet.externalTransactionId);
	rollback.markProcessed(changedAt, {
		transaction: bet,
		processedReversalKinds: [],
	});
	expect(
		uow.execute(context => context.transactions.insert(rollback)),
	).rejects.toMatchObject({
		code: '23514',
		constraint: 'wager_active_bet_compensation_check',
	});
	const rejected = make('ROLLBACK', bet.externalTransactionId);
	rejected.reject('CUMULATIVE_REVERSAL_NOT_ALLOWED');
	await uow.execute(context => context.transactions.insert(rejected));
	expect(
		await uow.execute(context =>
			context.transactions.findProcessedReversalKinds(bet.id),
		),
	).toEqual(['REFUND']);
});

test('SQL permits the unused modality after refund neutralization and refuses destructive schema rollback', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const make = (
		kind: 'BET' | 'REFUND' | 'ROLLBACK',
		original?: WagerTransaction,
	): WagerTransaction => {
		const tx = wager(wallet, {
			kind,
			referenceExternalTransactionId: original?.externalTransactionId,
		});
		tx.markProcessed(
			changedAt,
			original === undefined
				? undefined
				: { transaction: original, processedReversalKinds: [] },
		);
		return tx;
	};
	const bet = make('BET');
	const refund = make('REFUND', bet);
	const undoRefund = make('ROLLBACK', refund);
	for (const tx of [bet, refund, undoRefund])
		await uow.execute(context => context.transactions.insert(tx));
	expect(
		await uow.execute(context =>
			context.transactions.hasReversedRefund(bet.id),
		),
	).toBe(true);
	const before = await orm.em.execute(
		'select * from wager_transactions order by id',
	);
	const direct = make('ROLLBACK', bet);
	await uow.execute(context => context.transactions.insert(direct));
	const kinds = await uow.execute(context =>
		context.transactions.findProcessedReversalKinds(bet.id),
	);
	expect([...kinds].sort()).toEqual(['REFUND', 'ROLLBACK']);
	const failedDown: unknown = await orm.migrator.down().then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failedDown).toMatchObject({ code: '23505' });
	expect(await orm.migrator.getPending()).toHaveLength(0);
	expect(
		await orm.em.execute(
			'select * from wager_transactions where id <> ? order by id',
			[direct.id],
		),
	).toEqual(before);
});

test.each(['REFUND', 'ROLLBACK'] as const)(
	'SQL preserves the exact per-modality constraint for duplicate %s',
	async kind => {
		const wallet = await uow.execute(context => openWallet(context));
		const bet = wager(wallet);
		bet.markProcessed(changedAt);
		await uow.execute(context => context.transactions.insert(bet));
		for (let attempt = 0; attempt < 2; attempt++) {
			const tx = wager(wallet, {
				kind,
				referenceExternalTransactionId: bet.externalTransactionId,
			});
			tx.markProcessed(changedAt, {
				transaction: bet,
				processedReversalKinds: [],
			});
			const failure: unknown = await uow
				.execute(context => context.transactions.insert(tx))
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			if (attempt === 0) expect(failure).toBeUndefined();
			else
				expect(failure).toMatchObject({
					code: '23505',
					constraint: 'wager_processed_reversal_unique',
				});
		}
	},
);

test('a mismatched historical rollback never supplies proof that a refund was neutralized', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const bet = wager(wallet);
	bet.markProcessed(changedAt);
	const refund = wager(wallet, {
		kind: 'REFUND',
		referenceExternalTransactionId: bet.externalTransactionId,
	});
	refund.markProcessed(changedAt, {
		transaction: bet,
		processedReversalKinds: [],
	});
	for (const tx of [bet, refund])
		await uow.execute(context => context.transactions.insert(tx));
	await orm.em.execute(
		`insert into wager_transactions
		(wallet_id, player_id, provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id, reference_transaction_id, processed_at)
		select wallet_id, player_id, 'different-provider', gen_random_uuid()::text, gen_random_uuid()::text, 'hash', round_id, game_id, 'ROLLBACK', 'PROCESSED', amount, currency, external_transaction_id, id, clock_timestamp()
		from wager_transactions where id = ?`,
		[refund.id],
	);
	expect(
		await uow.execute(context =>
			context.transactions.hasReversedRefund(bet.id),
		),
	).toBe(false);
	const direct = wager(wallet, {
		kind: 'ROLLBACK',
		referenceExternalTransactionId: bet.externalTransactionId,
	});
	direct.markProcessed(changedAt, {
		transaction: bet,
		processedReversalKinds: [],
	});
	const failure: unknown = await uow
		.execute(context => context.transactions.insert(direct))
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	expect(failure).toMatchObject({
		code: '23514',
		constraint: 'wager_active_bet_compensation_check',
	});
});

test('SQL keeps the historical cross-kind exclusion for non-BET references', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const win = wager(wallet, { kind: 'WIN' });
	win.markProcessed(changedAt);
	await uow.execute(context => context.transactions.insert(win));
	await orm.em.execute(
		`insert into wager_transactions
		(wallet_id, player_id, provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id, reference_transaction_id, processed_at)
		select wallet_id, player_id, provider_id, gen_random_uuid()::text, gen_random_uuid()::text, 'legacy', round_id, game_id, 'REFUND', 'PROCESSED', amount, currency, external_transaction_id, id, clock_timestamp()
		from wager_transactions where id = ?`,
		[win.id],
	);
	const rollback = wager(wallet, {
		kind: 'ROLLBACK',
		referenceExternalTransactionId: win.externalTransactionId,
	});
	rollback.markProcessed(changedAt, {
		transaction: win,
		processedReversalKinds: [],
	});
	const failure: unknown = await uow
		.execute(context => context.transactions.insert(rollback))
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	expect(failure).toMatchObject({
		code: '23514',
		constraint: 'wager_active_bet_compensation_check',
	});
});

test('SQL rejects a non-BET reversal routed through a different wallet before checking history', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const other = await uow.execute(context => openWallet(context));
	const win = wager(wallet, { kind: 'WIN' });
	win.markProcessed(changedAt);
	await uow.execute(context => context.transactions.insert(win));
	const failure: unknown = await orm.em
		.execute(
			`insert into wager_transactions
		(wallet_id, player_id, provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id, reference_transaction_id, processed_at)
		select ?, ?, provider_id, gen_random_uuid()::text, gen_random_uuid()::text, 'legacy', round_id, game_id, 'ROLLBACK', 'PROCESSED', amount, currency, external_transaction_id, id, clock_timestamp()
		from wager_transactions where id = ?`,
			[other.id, other.playerId, win.id],
		)
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	expect(failure).toMatchObject({
		code: '23514',
		constraint: 'wager_active_bet_compensation_check',
	});
});

test('SQL refuses a processed reversal while a non-BET reference is still pending', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const win = wager(wallet, { kind: 'WIN' });
	await uow.execute(context => context.transactions.insert(win));
	const failure: unknown = await orm.em
		.execute(
			`insert into wager_transactions
		(wallet_id, player_id, provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id, reference_transaction_id, processed_at)
		select wallet_id, player_id, provider_id, gen_random_uuid()::text, gen_random_uuid()::text, 'premature', round_id, game_id, 'ROLLBACK', 'PROCESSED', amount, currency, external_transaction_id, id, clock_timestamp()
		from wager_transactions where id = ?`,
			[win.id],
		)
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	expect(failure).toMatchObject({
		code: '23514',
		constraint: 'wager_active_bet_compensation_check',
	});
	win.markProcessed(changedAt);
	await uow.execute(context => context.transactions.save(win));
	const rollback = wager(wallet, {
		kind: 'ROLLBACK',
		referenceExternalTransactionId: win.externalTransactionId,
	});
	rollback.markProcessed(changedAt, {
		transaction: win,
		processedReversalKinds: [],
	});
	await uow.execute(context => context.transactions.insert(rollback));
	expect(
		(
			await uow.execute(context =>
				context.transactions.findById(rollback.id),
			)
		)?.status,
	).toBe('PROCESSED');
});

test('updates nonterminal state without reopening a terminal operation', async () => {
	const wallet = await uow.execute(context => openWallet(context));
	const transaction = wager(wallet, {
		kind: 'LOSS',
		money: money('0.00'),
	});
	await uow.execute(context => context.transactions.insert(transaction));
	transaction.markProcessed(changedAt);
	await uow.execute(context => context.transactions.save(transaction));
	expect(
		(
			await uow.execute(context =>
				context.transactions.findById(transaction.id),
			)
		)?.status,
	).toBe('PROCESSED');
	expect(
		uow.execute(context => context.transactions.save(transaction)),
	).rejects.toThrow('state conflict');
});
