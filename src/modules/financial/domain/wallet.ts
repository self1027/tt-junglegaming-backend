import type { BalanceChange, LedgerDirection } from './balance-change.js';
import {
	CurrencyMismatchError,
	InsufficientBalanceError,
	InvalidMoneyError,
	InvalidWalletStateError,
} from './errors.js';
import { Money } from './money.js';
import { isUuid, isValidDate } from './state-validation.js';

export interface CreateWalletProps {
	readonly id: string;
	readonly playerId: string;
	readonly currency: string;
	readonly createdAt: Date;
}

export interface WalletState extends CreateWalletProps {
	readonly balance: Money;
	readonly version: number;
	readonly updatedAt: Date;
}

export interface OpenWalletProps extends CreateWalletProps {
	readonly initialBalance: Money;
}

// PostgreSQL INTEGER is the persisted version representation, not a money limit.
const maxVersion = 2_147_483_647;

export class Wallet {
	readonly id: string;
	readonly playerId: string;
	readonly currency: string;
	readonly #createdAt: number;
	#balance: Money;
	#version: number;
	#updatedAt: number;

	private constructor(state: WalletState) {
		this.id = state.id;
		this.playerId = state.playerId;
		this.currency = state.currency;
		this.#balance = state.balance;
		this.#version = state.version;
		this.#createdAt = state.createdAt.getTime();
		this.#updatedAt = state.updatedAt.getTime();
		Object.freeze(this);
	}

	static create(props: CreateWalletProps): Wallet {
		return Wallet.rehydrate({
			...props,
			balance: Money.zero(props.currency),
			version: 1,
			updatedAt: props.createdAt,
		});
	}

	static open(props: OpenWalletProps): Wallet {
		return Wallet.rehydrate({
			...props,
			balance: props.initialBalance,
			version: 1,
			updatedAt: props.createdAt,
		});
	}

	static rehydrate(state: WalletState): Wallet {
		if (
			!isUuid(state.id) ||
			typeof state.playerId !== 'string' ||
			state.playerId.trim().length === 0 ||
			state.playerId.includes('\0') ||
			!(state.balance instanceof Money) ||
			state.balance.isNegative() ||
			state.balance.currency !== state.currency ||
			!Number.isInteger(state.version) ||
			state.version < 1 ||
			state.version > maxVersion ||
			!isValidDate(state.createdAt) ||
			!isValidDate(state.updatedAt) ||
			state.updatedAt < state.createdAt
		) {
			throw new InvalidWalletStateError('Invalid persisted wallet state');
		}
		return new Wallet(state);
	}

	get balance(): Money {
		return this.#balance;
	}

	get version(): number {
		return this.#version;
	}

	get createdAt(): Date {
		return new Date(this.#createdAt);
	}

	get updatedAt(): Date {
		return new Date(this.#updatedAt);
	}

	credit(amount: Money, at: Date): BalanceChange | undefined {
		return this.changeBalance('CREDIT', amount, at);
	}

	debit(amount: Money, at: Date): BalanceChange | undefined {
		return this.changeBalance('DEBIT', amount, at);
	}

	private changeBalance(
		direction: LedgerDirection,
		amount: Money,
		at: Date,
	): BalanceChange | undefined {
		if (!(amount instanceof Money)) {
			throw new InvalidMoneyError('Credit and debit require Money');
		}
		if (amount.currency !== this.currency) {
			throw new CurrencyMismatchError(
				'Operation currency must match wallet',
			);
		}
		if (amount.isNegative()) {
			throw new InvalidMoneyError(
				'Credit and debit amounts must be non-negative',
			);
		}
		if (!isValidDate(at) || at.getTime() < this.#updatedAt) {
			throw new InvalidWalletStateError(
				'Operation time must not precede wallet state',
			);
		}
		if (amount.isZero()) return undefined;
		if (this.#version === maxVersion) {
			throw new InvalidWalletStateError(
				'Persisted version would overflow',
			);
		}
		const balanceBefore = this.#balance;
		const balanceAfter =
			direction === 'CREDIT'
				? balanceBefore.add(amount)
				: balanceBefore.subtract(amount);
		if (balanceAfter.isNegative()) {
			throw new InsufficientBalanceError('Insufficient wallet balance');
		}
		const change: BalanceChange = Object.freeze({
			walletId: this.id,
			direction,
			amount,
			balanceBefore,
			balanceAfter,
		});
		this.#balance = balanceAfter;
		this.#version += 1;
		this.#updatedAt = at.getTime();
		return change;
	}
}
