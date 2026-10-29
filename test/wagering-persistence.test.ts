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
		await uow.execute(context => context.transactions.findById(refund.id)),
	).toBeDefined();
	await orm.migrator.up();
	const rollback = make('ROLLBACK', bet.externalTransactionId);
	rollback.markProcessed(changedAt, {
		transaction: bet,
		processedReversalKinds: [],
	});
	expect(
		uow.execute(context => context.transactions.insert(rollback)),
	).rejects.toMatchObject({ code: '23505' });
	const rejected = make('ROLLBACK', bet.externalTransactionId);
	rejected.reject('CUMULATIVE_REVERSAL_NOT_ALLOWED');
	await uow.execute(context => context.transactions.insert(rejected));
	expect(
		await uow.execute(context =>
			context.transactions.findProcessedReversalKinds(bet.id),
		),
	).toEqual(['REFUND']);
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
