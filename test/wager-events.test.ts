import { expect, test } from 'bun:test';
import {
	WagerTransactionProcessed,
	WagerTransactionRejected,
	WagerTransactionPendingReference,
	WalletBalanceChanged,
} from '../src/modules/wagering/public/events.js';

const transactionId = '0192f298-345e-7e38-af88-e43f851a819d';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const context = {
	eventId: '0192f291-27dd-7d3f-8071-5f8685deef38',
	aggregateId: transactionId,
	correlationId: 'operation-123',
	causationId: 'command-123',
	occurredAt: new Date('2026-10-28T15:00:00.000Z'),
};
const data = {
	transactionId,
	walletId,
	playerId: 'player',
	providerId: 'provider',
	externalTransactionId: 'external',
	kind: 'BET' as const,
	money: { amount: '9007199254740993.01', currency: 'BRL' },
	status: 'PROCESSED' as const,
};
const balance = {
	walletId,
	transactionId,
	direction: 'DEBIT' as const,
	money: { amount: '10.00', currency: 'BRL' },
	balanceBefore: { amount: '100.00', currency: 'BRL' },
	balanceAfter: { amount: '90.00', currency: 'BRL' },
	walletVersion: 2,
};

test('versioned processed event serializes an exact immutable envelope with explicit causality', () => {
	const occurredAt = new Date(context.occurredAt);
	const input = { ...data, money: { ...data.money } };
	const event = WagerTransactionProcessed.create({
		...context,
		occurredAt,
		data: input,
	});
	occurredAt.setTime(0);
	input.money.amount = '0.00';
	event.occurredAt.setTime(0);
	expect(JSON.parse(JSON.stringify(event))).toEqual({
		...context,
		occurredAt: '2026-10-28T15:00:00.000Z',
		eventType: 'WagerTransactionProcessed',
		version: 1,
		data,
	});
	expect(Object.isFrozen(event)).toBe(true);
	expect(Object.isFrozen(event.data)).toBe(true);
	expect(Object.isFrozen(event.data.money)).toBe(true);
	expect(() => Object.assign(event.data.money, { amount: '0.00' })).toThrow();
	expect(() => Object.assign(event, { version: 2 })).toThrow();
});

test('rejected and missing-reference facts keep distinct schemas and omit absent causation', () => {
	const { causationId: _causation, ...direct } = context;
	const rejected = WagerTransactionRejected.create({
		...direct,
		data: {
			...data,
			status: 'REJECTED',
			failureCode: 'BET_INSUFFICIENT_BALANCE',
		},
	});
	expect(rejected.toJSON()).toMatchObject({
		eventType: 'WagerTransactionRejected',
		version: 1,
		data: { failureCode: 'BET_INSUFFICIENT_BALANCE', status: 'REJECTED' },
	});
	expect(rejected.toJSON()).not.toHaveProperty('causationId');
	const pending = WagerTransactionPendingReference.create({
		...direct,
		data: {
			...data,
			kind: 'REFUND',
			status: 'PENDING_REFERENCE',
			referenceExternalTransactionId: 'missing',
		},
	});
	expect(pending.toJSON()).toMatchObject({
		eventType: 'WagerTransactionPendingReference',
		data: {
			referenceExternalTransactionId: 'missing',
			status: 'PENDING_REFERENCE',
		},
	});
});

test('wallet event belongs to wallet and verifies exact balance arithmetic', () => {
	const event = WalletBalanceChanged.create({
		...context,
		aggregateId: walletId,
		data: balance,
	});
	expect(event.toJSON()).toMatchObject({
		eventType: 'WalletBalanceChanged',
		aggregateId: walletId,
		version: 1,
		data: balance,
	});
	expect(Object.isFrozen(event.data.balanceBefore)).toBe(true);
	expect(() =>
		WalletBalanceChanged.create({
			...context,
			aggregateId: walletId,
			data: {
				...balance,
				balanceAfter: { amount: '91.00', currency: 'BRL' },
			},
		}),
	).toThrow();
	expect(() =>
		WalletBalanceChanged.create({
			...context,
			aggregateId: walletId,
			data: { ...balance, money: { amount: '0.00', currency: 'BRL' } },
		}),
	).toThrow();
});

test.each([
	{ eventId: 'invalid' },
	{ aggregateId: walletId },
	{ correlationId: '' },
	{ causationId: '\0' },
	{ occurredAt: new Date(NaN) },
	{ correlationId: '\ud800' },
])('invalid envelope is rejected before persistence: %j', invalid => {
	expect(() =>
		WagerTransactionProcessed.create({ ...context, ...invalid, data }),
	).toThrow();
});

test.each([
	{ money: { amount: '1e2', currency: 'BRL' } },
	{ money: { amount: '1.001', currency: 'BRL' } },
	{ money: { amount: '1.00', currency: 'XYZ' } },
	{ providerId: '' },
	{ playerId: '\ud800' },
	{ walletId: 'invalid' },
])('invalid event data is rejected before persistence: %j', invalid => {
	expect(() =>
		WagerTransactionProcessed.create({
			...context,
			data: { ...data, ...invalid },
		}),
	).toThrow();
});

test('factories reject forged type/status/version and non-JSON monetary values', () => {
	expect(() =>
		WagerTransactionProcessed.create({
			...context,
			data: {
				...data,
				// @ts-expect-error runtime validation of a forged status
				status: 'REJECTED',
			},
		}),
	).toThrow();
	expect(() =>
		WagerTransactionProcessed.create({
			...context,
			data: {
				...data,
				// @ts-expect-error money never crosses JSON as a number
				money: { amount: 10, currency: 'BRL' },
			},
		}),
	).toThrow();
	expect(() =>
		WagerTransactionProcessed.create({
			...context,
			data: {
				...data,
				// @ts-expect-error OPENING is not a submitted Wagering operation
				kind: 'OPENING',
			},
		}),
	).toThrow();
	expect(() =>
		WalletBalanceChanged.create({
			...context,
			aggregateId: walletId,
			data: { ...balance, walletVersion: 0 },
		}),
	).toThrow();
});

test('factories whitelist fields instead of leaking arbitrary request data', () => {
	const extra = {
		...data,
		credential: 'secret',
		rawRequest: { token: 'secret' },
	};
	expect(
		WagerTransactionProcessed.create({ ...context, data: extra }).toJSON()
			.data,
	).toEqual(data);
});
