import { isCurrency } from './currencies.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';

export interface MoneyProps {
	readonly amount: string;
	readonly currency: string;
}

export class Money {
	readonly #units: bigint;

	private constructor(
		units: bigint,
		public readonly currency: string,
	) {
		this.#units = units;
		Object.freeze(this);
	}

	static create(props: MoneyProps): Money {
		return Money.parse(props, false);
	}

	/** Signed reconstruction is for arithmetic results, never external inputs. */
	static rehydrate(props: MoneyProps): Money {
		return Money.parse(props, true);
	}

	static zero(currency: string): Money {
		return Money.create({ amount: '0.00', currency });
	}

	private static parse(props: MoneyProps, signed: boolean): Money {
		const format = signed ? /^-?\d+\.\d{2}$/ : /^\d+\.\d{2}$/;
		if (
			typeof props.amount !== 'string' ||
			props.amount.trim() !== props.amount ||
			!format.test(props.amount) ||
			!isCurrency(props.currency)
		) {
			throw new InvalidMoneyError(
				'Expected scale-2 decimal and ISO-4217 currency',
			);
		}
		return new Money(BigInt(props.amount.replace('.', '')), props.currency);
	}

	add(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.#units + other.#units, this.currency);
	}

	subtract(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.#units - other.#units, this.currency);
	}

	negate(): Money {
		return new Money(-this.#units, this.currency);
	}

	equals(other: Money): boolean {
		return this.compare(other) === 0;
	}

	compare(other: Money): -1 | 0 | 1 {
		this.assertSameCurrency(other);
		if (this.#units < other.#units) return -1;
		if (this.#units > other.#units) return 1;
		return 0;
	}

	isZero(): boolean {
		return this.#units === 0n;
	}

	isPositive(): boolean {
		return this.#units > 0n;
	}

	isNegative(): boolean {
		return this.#units < 0n;
	}

	toProps(): MoneyProps {
		const absolute = this.#units < 0n ? -this.#units : this.#units;
		const sign = this.isNegative() ? '-' : '';
		return {
			amount: `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`,
			currency: this.currency,
		};
	}

	private assertSameCurrency(other: Money): void {
		if (this.currency !== other.currency) {
			throw new CurrencyMismatchError('Money currencies must match');
		}
	}
}
