import { expect, test } from 'bun:test';
import {
	pendingWorkerConfig,
	pendingBackoff,
} from '../src/modules/wagering/adapters/worker/pending-config.js';
import { PendingReferenceWorker } from '../src/modules/wagering/adapters/worker/pending-reference-worker.js';
import type {
	PendingWagerClaim,
	PendingWagerStore,
} from '../src/modules/wagering/public/pending.js';
import { PendingClaimLostError } from '../src/modules/wagering/public/pending.js';
import { processWager } from '../src/modules/wagering/application/process-wager.js';
import { WagerTransaction } from '../src/modules/wagering/public/index.js';
import { Wallet } from '../src/modules/financial/public/index.js';
import { money, createdAt } from './support/financial.js';
import type { WageringTransactionContext } from '../src/modules/wagering/public/persistence.js';

test('SQL-only config has approved TTL, finite compatible budgets and bounded jitter', () => {
	const config = pendingWorkerConfig({});
	expect(config.ttlMs).toBe(86400000);
	expect(config.leaseMs).toBeGreaterThan(2 * config.sqlMs);
	expect(pendingBackoff(1, config, 0)).toBe(1000);
	expect(pendingBackoff(4, config, 0.5)).toBe(4500);
	expect(pendingBackoff(2147483647, config, 0.5)).toBe(150500);
	expect(pendingWorkerConfig({ PENDING_TTL_MS: '604800000' }).ttlMs).toBe(
		604800000,
	);
});

test.each([
	{ PENDING_SQL_MS: '0' },
	{ PENDING_POLL_MS: '1.5' },
	{ PENDING_LEASE_MS: '100' },
	{ PENDING_SHUTDOWN_MS: '100' },
	{ PENDING_BATCH_SIZE: '5' },
	{ PENDING_CONCURRENCY: '101' },
	{ PENDING_TTL_MS: '2592000001' },
	{ PENDING_TTL_MS: '-1' },
	{ PENDING_INSTANCE_ID: '\ud800' },
	{ PENDING_BACKOFF_MIN_MS: '300001' },
])('rejects invalid worker configuration %j', env => {
	expect(() => pendingWorkerConfig(env)).toThrow();
});

test('shutdown during acquisition never starts a resolution', async () => {
	let calls = 0;
	const store: PendingWagerStore = {
		claim: () => {
			worker.requestStop();
			return Promise.resolve([{} as PendingWagerClaim]);
		},
		retry: () => Promise.resolve(),
	};
	const worker = new PendingReferenceWorker(
		store,
		{
			execute: (): Promise<'WAITING'> => {
				calls++;
				return Promise.resolve('WAITING');
			},
		},
		pendingWorkerConfig({}),
	);
	await worker.run();
	expect(calls).toBe(0);
});

test.each([false, true])(
	'shutdown drains started resolution; claim loss never schedules SQL retry (%s)',
	async lost => {
		let attempts = 0;
		let retries = 0;
		const claim = {
			transaction: {
				id: 'transaction',
				walletId: 'wallet',
				providerId: 'provider',
			},
			token: 'token',
			attempts: 2,
		} as PendingWagerClaim;
		const store: PendingWagerStore = {
			claim: () => {
				attempts++;
				return Promise.resolve([claim]);
			},
			retry: () => {
				retries++;
				return Promise.resolve();
			},
		};
		const worker = new PendingReferenceWorker(
			store,
			{
				execute: async (): Promise<never> => {
					worker.requestStop();
					await Promise.resolve();
					if (lost) throw new PendingClaimLostError();
					throw new Error('SQL failure');
				},
			},
			pendingWorkerConfig({}),
		);
		await worker.run();
		expect(attempts).toBe(1);
		expect(retries).toBe(lost ? 0 : 1);
	},
);

test.each(['MISSING', 'PENDING', 'PROCESSED', 'REJECTED', 'FAILED'] as const)(
	'expired reference decision is reevaluated in the shared application without PostgreSQL: %s',
	async status => {
		const wallet = Wallet.open({
			id: crypto.randomUUID(),
			playerId: 'player',
			currency: 'BRL',
			initialBalance: money('100.00'),
			createdAt,
		});
		const base = {
			providerId: 'provider',
			playerId: wallet.playerId,
			walletId: wallet.id,
			roundId: 'round',
			gameId: 'game',
			money: money('10.00'),
			payloadHash: 'hash',
			createdAt,
		};
		const reference = WagerTransaction.create({
			...base,
			id: crypto.randomUUID(),
			externalTransactionId: 'bet',
			idempotencyKey: 'bet',
			kind: 'BET',
		});
		if (status === 'PROCESSED') reference.markProcessed(createdAt);
		if (status === 'REJECTED') reference.reject('TEST_REJECTION');
		if (status === 'FAILED') reference.fail('TEST_PERMANENT');
		const transaction = WagerTransaction.create({
			...base,
			id: crypto.randomUUID(),
			externalTransactionId: 'refund',
			idempotencyKey: 'refund',
			kind: 'REFUND',
			referenceExternalTransactionId: 'bet',
		});
		transaction.markPendingReference();
		const unexpected = (): Promise<never> =>
			Promise.reject(new Error('Unexpected persistence'));
		const transactions: WageringTransactionContext['transactions'] = {
			findByExternalIdentity: () =>
				Promise.resolve(status === 'MISSING' ? undefined : reference),
			findProcessedReversalKinds: () => Promise.resolve([]),
			hasReversedRefund: () => Promise.resolve(false),
			findById: unexpected,
			insert: unexpected,
			insertProcessed: unexpected,
			save: unexpected,
			lockExternalIdentity: unexpected,
		};
		const result = await processWager(
			transaction,
			wallet,
			{ transactions } as WageringTransactionContext,
			createdAt,
			true,
		);
		if (status === 'PROCESSED') {
			expect(result.result.status).toBe('PROCESSED');
			expect(wallet.balance.toProps().amount).toBe('110.00');
		} else {
			expect(result.result).toMatchObject({
				status: 'REJECTED',
				failureCode:
					status === 'MISSING'
						? 'REFERENCE_NOT_FOUND_EXHAUSTED'
						: status === 'PENDING'
							? 'REFERENCE_NOT_PROCESSED_EXHAUSTED'
							: 'REFERENCE_TERMINAL_INELIGIBLE',
			});
			expect(result.change).toBeUndefined();
			expect(wallet.balance.toProps().amount).toBe('100.00');
		}
	},
);
