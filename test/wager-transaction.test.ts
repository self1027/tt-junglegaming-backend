import { describe, expect, test } from 'bun:test';
import { Money } from '../src/modules/financial/public/index.js';
import {
	ForbiddenWagerTransitionError,
	IncompatibleWagerReferenceError,
	InvalidWagerOperationError,
	InvalidWagerReversalError,
	InvalidWagerStateError,
	WagerDecisionRequiredError,
	WagerFinancialInvariantError,
	WagerTransaction,
} from '../src/modules/wagering/public/index.js';
import type {
	CreateWagerTransactionProps,
	WagerReference,
	WagerTransactionKind,
	WagerTransactionState,
	WagerTransactionStatus,
} from '../src/modules/wagering/public/index.js';

const id = '0192f298-345e-7e38-af88-e43f851a819d';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const createdAt = new Date('2026-10-28T12:00:00.000Z');
const later = new Date('2026-10-28T12:01:00.000Z');

function money(amount = '25.00', currency = 'BRL'): Money {
	return Money.create({ amount, currency });
}

function props(
	overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
	return {
		id,
		walletId,
		playerId: 'player-1',
		providerId: 'provider-a',
		externalTransactionId: 'bet-1',
		idempotencyKey: 'key-1',
		payloadHash: 'opaque-business-hash',
		roundId: 'round-1',
		gameId: 'game-1',
		kind: 'BET',
		money: money(),
		createdAt,
		...overrides,
	};
}

function state(
	status: WagerTransactionStatus,
	overrides: Partial<WagerTransactionState> = {},
): WagerTransactionState {
	return {
		...props(),
		status,
		...(status === 'PROCESSED' ? { processedAt: later } : {}),
		...(status === 'REJECTED' || status === 'FAILED'
			? { failureCode: 'caller-supplied-code' }
			: {}),
		...overrides,
	};
}

describe('WagerTransaction identity and state', () => {
	test('creates PENDING with immutable business identity and opaque payload comparison', () => {
		const wager = WagerTransaction.create(props());
		expect(wager.status).toBe('PENDING');
		expect(wager.id).toBe(id);
		expect(wager.walletId).toBe(walletId);
		expect(wager.currency).toBe('BRL');
		expect(wager.referenceTransactionId).toBeUndefined();
		expect(wager.processedAt).toBeUndefined();
		expect(wager.failureCode).toBeUndefined();
		expect(wager.isTerminal()).toBe(false);
		expect(wager.requiresReference()).toBe(false);
		expect(wager.matchesPayload('opaque-business-hash')).toBe(true);
		expect(wager.matchesPayload('different')).toBe(false);
		expect(Reflect.set(wager, 'id', 'other')).toBe(false);
		expect(Reflect.set(wager, 'status', 'PROCESSED')).toBe(false);
	});

	test('requires UUIDs internally and nonempty text identities without assuming external UUIDs', () => {
		for (const field of [
			'id',
			'walletId',
			'playerId',
			'providerId',
			'externalTransactionId',
			'idempotencyKey',
			'payloadHash',
			'roundId',
			'gameId',
		] as const) {
			for (const value of ['', '  ', 'bad\0text']) {
				expect(() =>
					WagerTransaction.create(props({ [field]: value })),
				).toThrow(InvalidWagerStateError);
			}
		}
		for (const field of ['id', 'walletId'] as const) {
			expect(() =>
				WagerTransaction.create(props({ [field]: 'not-uuid' })),
			).toThrow(InvalidWagerStateError);
		}
		expect(
			WagerTransaction.create(props({ id: id.toUpperCase() })).id,
		).toBe(id);
	});

	test('does not accept OPENING or unknown provider operations even at runtime', () => {
		for (const kind of ['OPENING', 'UNKNOWN', 'bet']) {
			expect(() =>
				WagerTransaction.create(
					props({
						// @ts-expect-error Runtime validation of an untrusted operation.
						kind,
					}),
				),
			).toThrow(InvalidWagerOperationError);
		}
	});

	test('rejects malformed Unicode identities at the shared domain boundary', () => {
		for (const field of [
			'providerId',
			'externalTransactionId',
			'idempotencyKey',
			'playerId',
			'roundId',
			'gameId',
			'referenceExternalTransactionId',
		] as const) {
			for (const value of ['\ud800', '\udfff']) {
				expect(() =>
					WagerTransaction.create(props({ [field]: value })),
				).toThrow(InvalidWagerStateError);
			}
		}
	});

	test('rejects signed negative Money and invalid dates without using a clock', () => {
		expect(() =>
			WagerTransaction.create(props({ money: money().negate() })),
		).toThrow(InvalidWagerStateError);
		expect(() =>
			WagerTransaction.create(props({ createdAt: new Date('invalid') })),
		).toThrow(InvalidWagerStateError);
	});

	test('rehydrates all states without replaying processing or requiring a historical policy decision', () => {
		for (const status of [
			'PENDING',
			'PROCESSED',
			'REJECTED',
			'FAILED',
		] as const) {
			const wager = WagerTransaction.rehydrate(
				state(status, { money: money('0.00') }),
			);
			expect(wager.status).toBe(status);
			expect(wager.money.isZero()).toBe(true);
			expect(wager.processedAt).toEqual(
				status === 'PROCESSED' ? later : undefined,
			);
		}
		const waiting = WagerTransaction.rehydrate(
			state('PENDING_REFERENCE', {
				kind: 'REFUND',
				referenceExternalTransactionId: 'original',
			}),
		);
		expect(waiting.status).toBe('PENDING_REFERENCE');
		expect(waiting.referenceTransactionId).toBeUndefined();
	});

	test('rejects inconsistent persisted states rather than silently repairing them', () => {
		const invalid: WagerTransactionState[] = [
			state('PROCESSED', { processedAt: undefined }),
			state('PENDING', { processedAt: later }),
			state('REJECTED', { failureCode: undefined }),
			state('FAILED', { failureCode: '' }),
			state('PENDING', { failureCode: 'unexpected' }),
			state('PROCESSED', { processedAt: new Date('2026-01-01') }),
			state('PENDING_REFERENCE'),
			state('PROCESSED', {
				kind: 'REFUND',
				referenceExternalTransactionId: 'bet-0',
			}),
			// @ts-expect-error Runtime validation of an untrusted persisted status.
			state('UNKNOWN'),
		];
		for (const value of invalid) {
			expect(() => WagerTransaction.rehydrate(value)).toThrow(
				InvalidWagerStateError,
			);
		}
	});

	test('copies timestamps on entry and exit and protects identity from mutable input', () => {
		const input = props({ createdAt: new Date(createdAt) });
		const wager = WagerTransaction.create(input);
		input.createdAt.setUTCFullYear(2000);
		wager.createdAt.setUTCFullYear(2001);
		expect(wager.createdAt).toEqual(createdAt);
		const processed = WagerTransaction.rehydrate(state('PROCESSED'));
		processed.processedAt?.setUTCFullYear(2000);
		expect(processed.processedAt).toEqual(later);
	});

	test('distinguishes explicit business rejection from permanent technical failure', () => {
		const rejected = WagerTransaction.create(props());
		rejected.reject('business-code');
		expect(rejected.status).toBe('REJECTED');
		expect(rejected.failureCode).toBe('business-code');
		const failed = WagerTransaction.create(props());
		failed.fail('technical-code');
		expect(failed.status).toBe('FAILED');
		expect(failed.failureCode).toBe('technical-code');
		for (const wager of [rejected, failed]) {
			expect(wager.processedAt).toBeUndefined();
			expect(wager.referenceTransactionId).toBeUndefined();
		}
	});

	test('validates failure information before mutation', () => {
		for (const method of ['reject', 'fail'] as const) {
			const wager = WagerTransaction.create(props());
			expect(() => {
				wager[method](' ');
			}).toThrow(InvalidWagerStateError);
			expect(wager.status).toBe('PENDING');
			expect(wager.failureCode).toBeUndefined();
		}
	});

	test('protects every terminal state from every new decision or transition', () => {
		for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
			const wager = WagerTransaction.rehydrate(state(status));
			for (const action of [
				(): void => {
					wager.markProcessed(later);
				},
				(): void => {
					wager.markPendingReference();
				},
				(): void => {
					wager.reject('other');
				},
				(): void => {
					wager.fail('other');
				},
				(): void => {
					wager.processingDecision();
				},
			]) {
				expect(action).toThrow(ForbiddenWagerTransitionError);
				expect(wager.status).toBe(status);
			}
			expect(wager.isTerminal()).toBe(true);
		}
	});
});

function reference(
	overrides: Partial<WagerTransactionState> = {},
	processedReversalKinds: WagerReference['processedReversalKinds'] = [],
): WagerReference {
	return {
		transaction: WagerTransaction.rehydrate(
			state('PROCESSED', {
				id: '0192f298-345e-7e38-af88-e43f851a819e',
				externalTransactionId: 'original',
				...overrides,
			}),
		),
		processedReversalKinds,
	};
}

function reversal(kind: 'REFUND' | 'ROLLBACK' = 'REFUND'): WagerTransaction {
	return WagerTransaction.create(
		props({
			kind,
			referenceExternalTransactionId: 'original',
		}),
	);
}
