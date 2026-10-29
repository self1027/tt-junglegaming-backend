import { expect, test } from 'bun:test';
import {
	IdempotencyKeyPipe,
	LedgerQueryPipe,
} from '../src/platform/http/input.js';
import {
	WagerBodyPipe,
	wagerResponse,
} from '../src/modules/wagering/adapters/http/wager-input.js';
import { CreateWalletPipe } from '../src/modules/financial/adapters/http/wallet-input.js';
import type { ProcessWagerResult } from '../src/modules/wagering/public/process-wager.js';

test('runtime DTO creates only the application command and preserves exact Unicode', () => {
	const body = {
		providerId: 'provider-🦧',
		externalTransactionId: 'e\u0301',
		walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
		playerId: 'p',
		roundId: 'r',
		gameId: 'g',
		kind: 'BET',
		money: { amount: '9007199254740993.01', currency: 'BRL' },
	};
	expect(new WagerBodyPipe().transform(body)).toEqual({
		providerId: 'provider-🦧',
		externalTransactionId: 'e\u0301',
		walletId: body.walletId.toLowerCase(),
		playerId: 'p',
		roundId: 'r',
		gameId: 'g',
		kind: 'BET',
		amount: { amount: '9007199254740993.01', currency: 'BRL' },
		referenceExternalTransactionId: undefined,
	});
	expect(() =>
		new WagerBodyPipe().transform({ ...body, idempotencyKey: 'untrusted' }),
	).toThrow();
	expect(() =>
		new CreateWalletPipe().transform({
			playerId: 'p',
			initialBalance: { amount: 1, currency: 'BRL' },
		}),
	).toThrow();
});

test('runtime header and pagination validate unknown objects and duplicate query fields', () => {
	for (const value of [
		undefined,
		null,
		'',
		' ',
		'x y',
		'x,y',
		'x\u007fy',
		'\ud800',
		['x', 'y'],
		1,
	])
		expect(() => new IdempotencyKeyPipe().transform(value)).toThrow();
	expect(new IdempotencyKeyPipe().transform('provider:transaction-123')).toBe(
		'provider:transaction-123',
	);
	expect(new LedgerQueryPipe().transform({})).toEqual({
		cursor: undefined,
		limit: 50,
	});
	for (const query of [
		{ limit: ['1', '2'] },
		{ limit: 'Infinity' },
		{ cursor: [] },
		{ extra: 'x' },
	])
		expect(() => new LedgerQueryPipe().transform(query)).toThrow();
});

test.each([
	['PROCESSED', 200],
	['REJECTED', 422],
	['PENDING', 202],
	['PENDING_REFERENCE', 202],
	['FAILED', 500],
] as const)(
	'HTTP status for %s preserves the application result',
	(status, code) => {
		const result = {
			transactionId: 'id',
			externalTransactionId: 'external',
			walletId: 'wallet',
			idempotentReplay: true,
			status,
			balance: { amount: '1.00', currency: 'BRL' },
			failureCode: 'code',
			pendingReference: {
				reason: 'NOT_FOUND',
				externalTransactionId: 'missing',
			},
		} as ProcessWagerResult;
		let observed = 0;
		expect(
			wagerResponse(result, {
				status: value => {
					observed = value;
				},
			}),
		).toBe(result);
		expect(observed).toBe(code);
	},
);
