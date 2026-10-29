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

describe('WagerTransaction operations', () => {
	test.each([
		['BET', 'DEBIT'],
		['WIN', 'CREDIT'],
		['LOSS', 'NONE'],
	] as const)(
		'%s expresses %s without applying a Wallet change',
		(kind, direction) => {
			const wager = WagerTransaction.create(props({ kind }));
			const decision = wager.processingDecision();
			expect(decision).toMatchObject({
				type: 'READY',
				consequence: { direction },
			});
			expect(wager.status).toBe('PENDING');
			const effect = wager.markProcessed(later);
			expect(effect.direction).toBe(direction);
			if (effect.direction !== 'NONE') {
				expect(effect.money.toProps()).toEqual({
					amount: '25.00',
					currency: 'BRL',
				});
			}
			expect(Object.isFrozen(effect)).toBe(true);
			expect(wager.status).toBe('PROCESSED');
			expect(wager.processedAt).toEqual(later);
			expect(() => wager.markProcessed(later)).toThrow(
				ForbiddenWagerTransitionError,
			);
		},
	);

	test('LOSS produces NONE for zero and nonzero amounts without ledger data', () => {
		for (const amount of ['0.00', '999999999999999999999.99']) {
			const wager = WagerTransaction.create(
				props({ kind: 'LOSS', money: money(amount) }),
			);
			expect(wager.markProcessed(later)).toEqual({ direction: 'NONE' });
		}
	});

	test.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'] as const)(
		'does not invent acceptance or rejection of zero for %s',
		kind => {
			const wager = WagerTransaction.create(
				props({
					kind,
					money: money('0.00'),
					...(kind === 'REFUND' || kind === 'ROLLBACK'
						? { referenceExternalTransactionId: 'original' }
						: {}),
				}),
			);
			const found =
				kind === 'REFUND' || kind === 'ROLLBACK'
					? reference({ money: money('0.00') })
					: undefined;
			expect(wager.processingDecision(found)).toEqual({
				type: 'POLICY_REQUIRED',
				policy: 'ZERO_AMOUNT',
			});
			expect(() => wager.markProcessed(later, found)).toThrow(
				WagerDecisionRequiredError,
			);
			expect(wager.status).toBe('PENDING');
			expect(wager.processedAt).toBeUndefined();
		},
	);

	test.each([
		['REFUND', 'BET', 'CREDIT'],
		['ROLLBACK', 'BET', 'CREDIT'],
		['ROLLBACK', 'WIN', 'DEBIT'],
		['ROLLBACK', 'REFUND', 'DEBIT'],
	] as const)(
		'%s of processed %s expresses %s for the entire amount',
		(kind, originalKind, direction) => {
			const original = reference({
				kind: originalKind,
				...(originalKind === 'REFUND'
					? {
							referenceExternalTransactionId: 'older-bet',
							referenceTransactionId:
								'0192f298-345e-7e38-af88-e43f851a819f',
						}
					: {}),
			});
			const wager = reversal(kind);
			expect(wager.requiresReference()).toBe(true);
			const effect = wager.markProcessed(later, original);
			expect(effect.direction).toBe(direction);
			if (effect.direction !== 'NONE')
				expect(effect.money.toProps().amount).toBe('25.00');
			expect(wager.referenceTransactionId).toBe(original.transaction.id);
			expect(original.transaction.status).toBe('PROCESSED');
		},
	);

	test('rejecting a debit or reversal never produces a financial consequence', () => {
		for (const wager of [WagerTransaction.create(props()), reversal()]) {
			wager.reject('opaque-business-rejection');
			expect(() => wager.processingDecision()).toThrow(
				ForbiddenWagerTransitionError,
			);
			expect(() => wager.markProcessed(later, reference())).toThrow(
				ForbiddenWagerTransitionError,
			);
			expect(wager.processedAt).toBeUndefined();
			expect(wager.referenceTransactionId).toBeUndefined();
		}
	});

	test('a bad processing time cannot partially bind a reference or mutate state', () => {
		for (const at of [new Date('invalid'), new Date('2026-01-01')]) {
			const wager = reversal();
			expect(() => wager.markProcessed(at, reference())).toThrow(
				InvalidWagerStateError,
			);
			expect(wager.status).toBe('PENDING');
			expect(wager.referenceTransactionId).toBeUndefined();
			expect(wager.processedAt).toBeUndefined();
		}
	});
});

describe('WagerTransaction references and reversals', () => {
	test.each(['REFUND', 'ROLLBACK'] as const)(
		'%s requires an external reference at creation',
		kind => {
			expect(() => WagerTransaction.create(props({ kind }))).toThrow(
				InvalidWagerReversalError,
			);
			expect(() =>
				WagerTransaction.create(
					props({ kind, referenceExternalTransactionId: '' }),
				),
			).toThrow(InvalidWagerStateError);
		},
	);

	test('prevents self reference by external or canonical internal identity', () => {
		expect(() =>
			WagerTransaction.create(
				props({
					kind: 'REFUND',
					referenceExternalTransactionId: 'bet-1',
				}),
			),
		).toThrow(IncompatibleWagerReferenceError);
		const wager = reversal();
		expect(() =>
			wager.processingDecision(reference({ id: id.toUpperCase() })),
		).toThrow(IncompatibleWagerReferenceError);
		expect(wager.status).toBe('PENDING');
		expect(() =>
			WagerTransaction.rehydrate(
				state('PROCESSED', {
					kind: 'REFUND',
					referenceExternalTransactionId: 'original',
					referenceTransactionId: id.toUpperCase(),
				}),
			),
		).toThrow(InvalidWagerStateError);
	});

	test('missing lookup becomes PENDING_REFERENCE and later resolves directly to PROCESSED', () => {
		const wager = reversal();
		expect(wager.processingDecision()).toEqual({
			type: 'PENDING_REFERENCE',
		});
		expect(() => wager.markProcessed(later)).toThrow(
			WagerDecisionRequiredError,
		);
		wager.markPendingReference();
		expect(wager.status).toBe('PENDING_REFERENCE');
		expect(wager.referenceTransactionId).toBeUndefined();
		expect(() => {
			wager.markPendingReference();
		}).toThrow(ForbiddenWagerTransitionError);
		expect(wager.markProcessed(later, reference()).direction).toBe(
			'CREDIT',
		);
		expect(wager.status).toBe('PROCESSED');
	});

	test('reference wait can end in explicit business rejection or permanent failure', () => {
		for (const method of ['reject', 'fail'] as const) {
			const wager = reversal();
			wager.markPendingReference();
			wager[method]('caller-supplied-expiration-or-permanent-failure');
			expect(wager.status).toBe(
				method === 'reject' ? 'REJECTED' : 'FAILED',
			);
			expect(wager.isTerminal()).toBe(true);
		}
	});

	test.each(['PENDING', 'PENDING_REFERENCE', 'REJECTED', 'FAILED'] as const)(
		'found %s reference is distinguishable from a missing one',
		status => {
			const found = reference({
				status,
				processedAt: undefined,
				...(status === 'PENDING_REFERENCE'
					? { kind: 'WIN', referenceExternalTransactionId: 'earlier' }
					: {}),
				...(status === 'REJECTED' || status === 'FAILED'
					? { failureCode: 'previous-result' }
					: {}),
			});
			const wager = reversal('ROLLBACK');
			expect(wager.processingDecision(found)).toEqual({
				type: 'REFERENCE_NOT_PROCESSED',
				status,
			});
			expect(() => wager.markProcessed(later, found)).toThrow(
				WagerDecisionRequiredError,
			);
			expect(() => {
				wager.markPendingReference(found);
			}).toThrow(WagerDecisionRequiredError);
			expect(wager.status).toBe('PENDING');
		},
	);

	test.each([
		{ providerId: 'other' },
		{ playerId: 'other' },
		{ walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' },
		{ roundId: 'other' },
		{ externalTransactionId: 'other' },
		{ money: money('25.00', 'USD') },
	])('rejects incompatible reference context %j before mutation', change => {
		const wager = reversal();
		expect(() => wager.markProcessed(later, reference(change))).toThrow(
			IncompatibleWagerReferenceError,
		);
		expect(wager.status).toBe('PENDING');
		expect(wager.referenceTransactionId).toBeUndefined();
	});

	test('does not require matching gameId, which is not a reference invariant in section 7', () => {
		expect(
			reversal().markProcessed(
				later,
				reference({ gameId: 'different-game' }),
			).direction,
		).toBe('CREDIT');
	});

	test('reversals require the exact original amount, including cents above number precision', () => {
		for (const amount of [
			'24.99',
			'25.01',
			'0.00',
			'9007199254740993.99',
		]) {
			expect(() =>
				reversal().processingDecision(
					reference({ money: money(amount) }),
				),
			).toThrow(WagerFinancialInvariantError);
		}
		const wager = WagerTransaction.create(
			props({
				kind: 'REFUND',
				referenceExternalTransactionId: 'original',
				money: money('9007199254740993.99'),
			}),
		);
		const effect = wager.markProcessed(
			later,
			reference({ money: money('9007199254740993.99') }),
		);
		expect(
			effect.direction === 'CREDIT' && effect.money.toProps().amount,
		).toBe('9007199254740993.99');
	});

	test.each([
		['REFUND', 'WIN'],
		['REFUND', 'LOSS'],
		['REFUND', 'REFUND'],
		['REFUND', 'ROLLBACK'],
		['ROLLBACK', 'LOSS'],
		['ROLLBACK', 'ROLLBACK'],
	] as const)('%s cannot reverse %s', (kind, originalKind) => {
		const original = reference({
			kind: originalKind,
			...(originalKind === 'REFUND' || originalKind === 'ROLLBACK'
				? {
						referenceExternalTransactionId: 'older',
						referenceTransactionId:
							'0192f298-345e-7e38-af88-e43f851a819f',
					}
				: {}),
		});
		expect(() => reversal(kind).processingDecision(original)).toThrow(
			InvalidWagerReversalError,
		);
	});

	test.each(['REFUND', 'ROLLBACK'] as const)(
		'rejects duplicate %s using supplied processed reversal history',
		kind => {
			const wager = reversal(kind);
			expect(() =>
				wager.processingDecision(reference({}, [kind])),
			).toThrow(InvalidWagerReversalError);
			expect(wager.status).toBe('PENDING');
		},
	);

	test.each([
		['REFUND', 'ROLLBACK'],
		['ROLLBACK', 'REFUND'],
	] as const)(
		'does not authorize %s after %s on the same BET without a cross-type policy',
		(kind, previous) => {
			const wager = reversal(kind);
			const found = reference({}, [previous]);
			expect(wager.processingDecision(found)).toEqual({
				type: 'POLICY_REQUIRED',
				policy: 'CROSS_TYPE_REVERSAL',
			});
			expect(() => wager.markProcessed(later, found)).toThrow(
				WagerDecisionRequiredError,
			);
			expect(wager.status).toBe('PENDING');
		},
	);

	test('reference history must explicitly contain valid reversal kinds', () => {
		const invalid = reference();
		expect(() =>
			reversal().processingDecision({
				...invalid,
				// @ts-expect-error Runtime boundary must not treat absent history as no previous reversals.
				processedReversalKinds: undefined,
			}),
		).toThrow(InvalidWagerReversalError);
		expect(() =>
			reversal().processingDecision({
				...invalid,
				// @ts-expect-error Only refund/rollback are reversal history facts.
				processedReversalKinds: ['WIN'],
			}),
		).toThrow(InvalidWagerReversalError);
	});

	test('WIN can reference a matching BET without requiring equal amounts or an unreversed BET', () => {
		const win = WagerTransaction.create(
			props({
				kind: 'WIN',
				money: money('50.00'),
				referenceExternalTransactionId: 'original',
			}),
		);
		expect(win.requiresReference()).toBe(false);
		expect(
			win.markProcessed(later, reference({}, ['REFUND'])).direction,
		).toBe('CREDIT');
		expect(win.referenceTransactionId).toBe(reference().transaction.id);
		const bad = WagerTransaction.create(
			props({ kind: 'WIN', referenceExternalTransactionId: 'original' }),
		);
		expect(() =>
			bad.processingDecision(reference({ kind: 'WIN' })),
		).toThrow(IncompatibleWagerReferenceError);
	});

	test('an optional WIN reference, when supplied, must be resolved', () => {
		const wager = WagerTransaction.create(
			props({ kind: 'WIN', referenceExternalTransactionId: 'original' }),
		);
		expect(wager.processingDecision()).toEqual({
			type: 'PENDING_REFERENCE',
		});
		wager.markPendingReference();
		expect(wager.markProcessed(later, reference()).direction).toBe(
			'CREDIT',
		);
	});

	test('does not silently attach an unrequested reference or wait without one', () => {
		for (const kind of [
			'BET',
			'LOSS',
			'WIN',
		] satisfies WagerTransactionKind[]) {
			const wager = WagerTransaction.create(props({ kind }));
			expect(() => wager.processingDecision(reference())).toThrow(
				IncompatibleWagerReferenceError,
			);
			expect(() => {
				wager.markPendingReference();
			}).toThrow(WagerDecisionRequiredError);
			expect(wager.status).toBe('PENDING');
		}
	});
});
