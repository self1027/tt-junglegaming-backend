import { describe, expect, test } from 'bun:test';
import {
	CurrencyMismatchError,
	InvalidMoneyError,
	Money,
} from '../src/modules/financial/public/index.js';

function money(amount: string, currency = 'BRL'): Money {
	return Money.create({ amount, currency });
}

describe('Money', () => {
	test('creates and serializes canonical scale-2 amounts without losing precision', () => {
		for (const amount of [
			'0.00',
			'0.01',
			'25.00',
			'123456789012345678901234567890.12',
		]) {
			expect(money(amount).toProps()).toEqual({
				amount,
				currency: 'BRL',
			});
			expect(
				Money.create(money(amount).toProps()).equals(money(amount)),
			).toBe(true);
		}
		expect(money('0001.20').toProps().amount).toBe('1.20');
	});

	test('adds, subtracts and negates with exact bigint arithmetic', () => {
		expect(money('0.10').add(money('0.20')).toProps().amount).toBe('0.30');
		expect(
			money('9007199254740993.99').add(money('0.01')).toProps().amount,
		).toBe('9007199254740994.00');
		expect(money('0.10').subtract(money('0.20')).toProps().amount).toBe(
			'-0.10',
		);
		expect(money('1.00').negate().toProps().amount).toBe('-1.00');
		expect(money('0.00').negate().toProps().amount).toBe('0.00');
		const negative = money('0.01').negate();
		expect(Money.rehydrate(negative.toProps()).equals(negative)).toBe(true);
		expect(() => Money.create(negative.toProps())).toThrow(
			InvalidMoneyError,
		);
	});

	test('compares ordering, equality, zero and signs', () => {
		const zero = Money.zero('BRL');
		expect(zero.isZero()).toBe(true);
		expect(zero.isPositive()).toBe(false);
		expect(zero.isNegative()).toBe(false);
		expect(money('0.01').isPositive()).toBe(true);
		expect(money('0.01').negate().isNegative()).toBe(true);
		expect(money('1.00').equals(money('1.00'))).toBe(true);
		expect(money('1.00').equals(money('1.01'))).toBe(false);
		expect(money('1.00').compare(money('1.01'))).toBe(-1);
		expect(money('1.01').compare(money('1.00'))).toBe(1);
		expect(zero.compare(zero)).toBe(0);
	});

	test('rejects currency mismatches for every binary operation', () => {
		const brl = money('1.00');
		const usd = money('1.00', 'USD');
		expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl.compare(usd)).toThrow(CurrencyMismatchError);
	});

	test.each([
		'',
		'NaN',
		'Infinity',
		'-Infinity',
		'1e2',
		'1E2',
		'-1.00',
		'-0.00',
		'1',
		'1.2',
		'1.001',
		'1.000',
		'+1.00',
		'.01',
		'1.',
		' 1.00',
		'1.00 ',
		'1.00\n',
		'1,00',
		'1_000.00',
		'1,000.00',
		'0x10',
		'１.00',
	])('rejects invalid external amount %j', amount => {
		expect(() => money(amount)).toThrow(InvalidMoneyError);
	});

	test.each(['', 'brl', 'BR', 'BRLL', 'ZZZ', 'BTC', ' USD', 'USD\n', 'BGN'])(
		'rejects invalid or withdrawn currency %j',
		currency => {
			expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
		},
	);

	test('uses ISO codes independently of runtime locale and keeps the contract scale', () => {
		for (const currency of [
			'BRL',
			'USD',
			'EUR',
			'JPY',
			'KWD',
			'XCG',
			'ZWG',
		]) {
			expect(money('1.00', currency).currency).toBe(currency);
		}
	});

	test('rejects runtime non-string input and malformed signed reconstruction', () => {
		// @ts-expect-error Runtime boundary must reject numeric money, even from untyped callers.
		expect(() => Money.create({ amount: 1, currency: 'BRL' })).toThrow(
			InvalidMoneyError,
		);
		for (const amount of ['-1.001', '--1.00', '-Infinity', '-1e2']) {
			expect(() => Money.rehydrate({ amount, currency: 'BRL' })).toThrow(
				InvalidMoneyError,
			);
		}
	});

	test('is immutable and returns new instances and detached props', () => {
		const original = money('1.00');
		const props = original.toProps();
		expect(Reflect.set(props, 'amount', '999.00')).toBe(true);
		expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
		expect(original.toProps()).toEqual({ amount: '1.00', currency: 'BRL' });
		expect(original.add(Money.zero('BRL'))).not.toBe(original);
		expect(original.subtract(Money.zero('BRL'))).not.toBe(original);
		expect(original.negate()).not.toBe(original);
	});

	test('preserves arithmetic inverse and ordering invariants across exact cent amounts', () => {
		for (let units = 0n; units <= 300n; units += 7n) {
			const value = money(
				`${(units / 100n).toString()}.${(units % 100n).toString().padStart(2, '0')}`,
			);
			const other = money('12345678901234567890.99');
			expect(value.add(other).subtract(other).equals(value)).toBe(true);
			expect(value.add(value.negate()).isZero()).toBe(true);
			expect(value.negate().negate().equals(value)).toBe(true);
			expect(value.compare(other)).toBe(-1);
		}
	});
});
