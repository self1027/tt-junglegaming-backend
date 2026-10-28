import { describe, expect, test } from 'bun:test';
import {
	CurrencyMismatchError,
	InsufficientBalanceError,
	InvalidMoneyError,
	InvalidWalletStateError,
	Money,
	Wallet,
	WalletLedgerEntry,
} from '../src/modules/financial/public/index.js';
import type { WalletState } from '../src/modules/financial/public/index.js';

const id = '0192f291-27dd-7d3f-8071-5f8685deef37';
const createdAt = new Date('2026-10-28T12:00:00.000Z');
const later = new Date('2026-10-28T12:01:00.000Z');
const props = { id, playerId: 'player-1', currency: 'BRL', createdAt };

function money(amount: string, currency = 'BRL'): Money {
	return Money.create({ amount, currency });
}

function state(wallet: Wallet): WalletState {
	return {
		id: wallet.id,
		playerId: wallet.playerId,
		currency: wallet.currency,
		balance: wallet.balance,
		version: wallet.version,
		createdAt: wallet.createdAt,
		updatedAt: wallet.updatedAt,
	};
}

describe('Wallet', () => {
	test('creates only at zero with version 1 and preserves creation time', () => {
		const wallet = Wallet.create(props);
		expect(state(wallet)).toEqual({
			...props,
			balance: Money.zero('BRL'),
			version: 1,
			updatedAt: createdAt,
		});
		expect(wallet.balance.isZero()).toBe(true);
		// Excess runtime properties must never create an unbacked opening balance.
		expect(
			Wallet.create({
				...props,
				...{
					initialBalance: money('100.00'),
					balance: money('100.00'),
					version: 10,
				},
			}).balance.isZero(),
		).toBe(true);
	});

	test('rehydrates positive balance without changing version or timestamps', () => {
		const persisted = {
			...props,
			balance: money('100.00'),
			version: 7,
			updatedAt: later,
		};
		const wallet = Wallet.rehydrate(persisted);
		expect(state(wallet)).toEqual(persisted);
		expect(wallet.balance.toProps().amount).toBe('100.00');
	});

	test('credits and debits returning immutable ledger-ready changes', () => {
		const wallet = Wallet.create(props);
		const credit = wallet.credit(money('100.00'), later);
		expect(credit).toMatchObject({ walletId: id, direction: 'CREDIT' });
		expect(credit?.balanceBefore.toProps().amount).toBe('0.00');
		expect(credit?.balanceAfter.toProps().amount).toBe('100.00');
		expect(wallet.version).toBe(2);
		expect(wallet.updatedAt).toEqual(later);
		const debit = wallet.debit(money('100.00'), later);
		expect(debit?.direction).toBe('DEBIT');
		expect(debit?.balanceBefore.toProps().amount).toBe('100.00');
		expect(wallet.balance.isZero()).toBe(true);
		expect(wallet.version).toBe(3);
		expect(wallet.createdAt).toEqual(createdAt);
		expect(Reflect.set(credit ?? {}, 'walletId', 'other')).toBe(false);
		expect(credit?.balanceAfter.toProps().amount).toBe('100.00');
	});

	test('zero operations preserve balance instance, version and updatedAt without a movement', () => {
		const wallet = Wallet.create(props);
		const before = state(wallet);
		expect(wallet.credit(Money.zero('BRL'), later)).toBeUndefined();
		expect(wallet.debit(Money.zero('BRL'), later)).toBeUndefined();
		expect(state(wallet)).toEqual(before);
		expect(wallet.balance).toBe(before.balance);
	});

	test('every failed operation leaves all state unchanged', () => {
		const wallet = Wallet.create(props);
		wallet.credit(money('1.00'), later);
		const before = state(wallet);
		for (const operation of [
			{
				run: (): unknown => wallet.debit(money('1.01'), later),
				error: InsufficientBalanceError,
			},
			{
				run: (): unknown => wallet.credit(money('1.00', 'USD'), later),
				error: CurrencyMismatchError,
			},
			{
				run: (): unknown => wallet.debit(money('0.00', 'USD'), later),
				error: CurrencyMismatchError,
			},
			{
				run: (): unknown =>
					wallet.credit(money('1.00').negate(), later),
				error: InvalidMoneyError,
			},
			{
				run: (): unknown => wallet.debit(money('1.00').negate(), later),
				error: InvalidMoneyError,
			},
			{
				run: (): unknown => wallet.credit(money('1.00'), new Date(NaN)),
				error: InvalidWalletStateError,
			},
			{
				run: (): unknown => wallet.debit(money('1.00'), createdAt),
				error: InvalidWalletStateError,
			},
		]) {
			expect(operation.run).toThrow(operation.error);
			expect(state(wallet)).toEqual(before);
			expect(wallet.balance).toBe(before.balance);
		}
		expect(() => {
			// @ts-expect-error Untyped callers must provide an actual Money instance.
			wallet.credit('1.00', later);
		}).toThrow(InvalidMoneyError);
		expect(state(wallet)).toEqual(before);
	});

	test('rejects structurally invalid rehydration', () => {
		const valid = state(Wallet.create(props));
		const invalid: Partial<WalletState>[] = [
			{ id: '' },
			{ id: `${id}\n` },
			{ id: 'not-a-uuid' },
			{ playerId: '' },
			{ playerId: '  ' },
			{ playerId: 'player\0' },
			{ currency: 'USD' },
			{ balance: money('1.00').negate() },
			{ version: 0 },
			{ version: -1 },
			{ version: 1.5 },
			{ version: NaN },
			{ version: Infinity },
			{ version: 2_147_483_648 },
			{ createdAt: new Date(NaN) },
			{ updatedAt: new Date(NaN) },
			{ updatedAt: new Date('2026-10-27T00:00:00Z') },
		];
		for (const replacement of invalid) {
			expect(() =>
				Wallet.rehydrate({ ...valid, ...replacement }),
			).toThrow(InvalidWalletStateError);
		}
	});

	test('rejects version overflow before changing balance and still permits no-op', () => {
		const wallet = Wallet.rehydrate({
			...state(Wallet.create(props)),
			version: 2_147_483_647,
		});
		const before = state(wallet);
		expect(() => wallet.credit(money('0.01'), later)).toThrow(
			InvalidWalletStateError,
		);
		expect(wallet.credit(Money.zero('BRL'), later)).toBeUndefined();
		expect(state(wallet)).toEqual(before);
	});

	test('encapsulates state and isolates mutable Date inputs and outputs', () => {
		const inputDate = new Date(createdAt);
		const wallet = Wallet.create({ ...props, createdAt: inputDate });
		inputDate.setTime(0);
		wallet.createdAt.setTime(0);
		wallet.updatedAt.setTime(0);
		for (const [key, value] of [
			['id', 'other'],
			['playerId', 'other'],
			['currency', 'USD'],
			['balance', money('999.00')],
			['version', 99],
			['updatedAt', new Date(0)],
		] as const) {
			expect(Reflect.set(wallet, key, value)).toBe(false);
		}
		const operationTime = new Date(later);
		wallet.credit(money('1.00'), operationTime);
		operationTime.setTime(0);
		wallet.updatedAt.setTime(0);
		expect(wallet.createdAt).toEqual(createdAt);
		expect(wallet.updatedAt).toEqual(later);
		expect(wallet.version).toBe(2);
	});

	test('reconstructs materialized balance from every movement across a sequence', () => {
		const wallet = Wallet.create(props);
		let reconstructed = Money.zero('BRL');
		let movements = 0;
		for (let index = 0; index < 60; index += 1) {
			const change =
				index % 3 === 0
					? wallet.credit(money('0.03'), later)
					: wallet.debit(
							money(index % 3 === 1 ? '0.01' : '0.00'),
							later,
						);
			if (change === undefined) continue;
			const entry = WalletLedgerEntry.create({
				...change,
				id: crypto.randomUUID(),
				transactionId: crypto.randomUUID(),
				createdAt: later,
			});
			expect(entry.balanceBefore.equals(reconstructed)).toBe(true);
			reconstructed =
				entry.direction === 'CREDIT'
					? reconstructed.add(entry.amount)
					: reconstructed.subtract(entry.amount);
			movements += 1;
			expect(wallet.balance.equals(reconstructed)).toBe(true);
			expect(wallet.balance.isNegative()).toBe(false);
			expect(wallet.version).toBe(1 + movements);
		}
	});
});
