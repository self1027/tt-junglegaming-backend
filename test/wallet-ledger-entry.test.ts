import { describe, expect, test } from 'bun:test';
import {
	CurrencyMismatchError,
	InconsistentLedgerEntryError,
	Money,
	WalletLedgerEntry,
} from '../src/modules/financial/public/index.js';
import type { WalletLedgerEntryProps } from '../src/modules/financial/public/index.js';

function money(amount: string, currency = 'BRL'): Money {
	return Money.create({ amount, currency });
}

const props: WalletLedgerEntryProps = {
	id: '0192f298-345e-7e38-af88-e43f851a819d',
	walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
	transactionId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
	direction: 'CREDIT',
	amount: money('0.10'),
	balanceBefore: money('0.20'),
	balanceAfter: money('0.30'),
	createdAt: new Date('2026-10-28T12:00:00.000Z'),
};

describe('WalletLedgerEntry', () => {
	test('creates a credit with exact arithmetic and preserves identities', () => {
		const entry = WalletLedgerEntry.create(props);
		for (const key of [
			'id',
			'walletId',
			'transactionId',
			'direction',
		] as const) {
			expect(entry[key]).toBe(props[key]);
		}
		expect(entry.amount.toProps().amount).toBe('0.10');
		expect(entry.balanceAfter.toProps().amount).toBe('0.30');
		expect(entry.createdAt).toEqual(props.createdAt);
	});

	test('creates a debit exhausting balance', () => {
		const entry = WalletLedgerEntry.create({
			...props,
			direction: 'DEBIT',
			amount: money('0.20'),
			balanceAfter: Money.zero('BRL'),
		});
		expect(entry.direction).toBe('DEBIT');
		expect(entry.balanceAfter.isZero()).toBe(true);
	});

	test('rehydrates without replaying the credit or changing timestamps', () => {
		const entry = WalletLedgerEntry.rehydrate(props);
		expect(entry.balanceBefore).toBe(props.balanceBefore);
		expect(entry.balanceAfter).toBe(props.balanceAfter);
		expect(entry.createdAt).toEqual(props.createdAt);
		expect(() =>
			WalletLedgerEntry.rehydrate({
				...props,
				balanceAfter: money('0.31'),
			}),
		).toThrow(InconsistentLedgerEntryError);
	});

	test('rejects incorrect arithmetic in both directions', () => {
		for (const direction of ['CREDIT', 'DEBIT'] as const) {
			expect(() =>
				WalletLedgerEntry.create({
					...props,
					direction,
					balanceAfter: money('0.21'),
				}),
			).toThrow(InconsistentLedgerEntryError);
		}
	});

	test('rejects mismatched currency in each monetary field', () => {
		for (const key of [
			'amount',
			'balanceBefore',
			'balanceAfter',
		] as const) {
			expect(() =>
				WalletLedgerEntry.create({
					...props,
					[key]: money('0.10', 'USD'),
				}),
			).toThrow(CurrencyMismatchError);
		}
	});

	test('rejects zero, negative amounts and negative balances even when arithmetic matches', () => {
		for (const replacement of [
			{ amount: Money.zero('BRL'), balanceAfter: props.balanceBefore },
			{ amount: money('0.10').negate(), balanceAfter: money('0.10') },
			{
				balanceBefore: money('0.10').negate(),
				balanceAfter: Money.zero('BRL'),
			},
			{
				direction: 'DEBIT' as const,
				balanceAfter: money('0.10').negate(),
			},
		]) {
			expect(() =>
				WalletLedgerEntry.create({ ...props, ...replacement }),
			).toThrow(InconsistentLedgerEntryError);
		}
	});

	test('rejects malformed identifiers, dates and runtime direction', () => {
		for (const key of ['id', 'walletId', 'transactionId'] as const) {
			for (const value of [
				'',
				'  ',
				'transaction-1',
				`${props[key]}\n`,
			]) {
				expect(() =>
					WalletLedgerEntry.create({ ...props, [key]: value }),
				).toThrow(InconsistentLedgerEntryError);
			}
		}
		expect(() =>
			WalletLedgerEntry.create({ ...props, createdAt: new Date(NaN) }),
		).toThrow(InconsistentLedgerEntryError);
		expect(() => {
			// @ts-expect-error Untyped callers cannot bypass direction validation.
			WalletLedgerEntry.create({ ...props, direction: 'TRANSFER' });
		}).toThrow(InconsistentLedgerEntryError);
	});

	test('is immutable including nested money and Date input/output', () => {
		const date = new Date(props.createdAt);
		const input = { ...props, createdAt: date };
		const entry = WalletLedgerEntry.create(input);
		input.id = crypto.randomUUID();
		date.setTime(0);
		entry.createdAt.setTime(0);
		for (const key of [
			'id',
			'walletId',
			'transactionId',
			'direction',
			'amount',
			'balanceBefore',
			'balanceAfter',
			'createdAt',
		] as const) {
			expect(Reflect.set(entry, key, undefined)).toBe(false);
		}
		expect(Reflect.set(entry.amount, 'currency', 'USD')).toBe(false);
		expect(entry.id).toBe(props.id);
		expect(entry.createdAt).toEqual(props.createdAt);
	});
});
