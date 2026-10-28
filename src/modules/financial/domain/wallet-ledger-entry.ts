import type { BalanceChange, LedgerDirection } from './balance-change.js';
import { InconsistentLedgerEntryError } from './errors.js';
import { Money } from './money.js';
import { isUuid, isValidDate } from './state-validation.js';

export interface WalletLedgerEntryProps extends BalanceChange {
	readonly id: string;
	readonly transactionId: string;
	readonly createdAt: Date;
}

export class WalletLedgerEntry implements BalanceChange {
	readonly id: string;
	readonly walletId: string;
	readonly transactionId: string;
	readonly direction: LedgerDirection;
	readonly amount: Money;
	readonly balanceBefore: Money;
	readonly balanceAfter: Money;
	readonly #createdAt: number;

	private constructor(props: WalletLedgerEntryProps) {
		this.id = props.id;
		this.walletId = props.walletId;
		this.transactionId = props.transactionId;
		this.direction = props.direction;
		this.amount = props.amount;
		this.balanceBefore = props.balanceBefore;
		this.balanceAfter = props.balanceAfter;
		this.#createdAt = props.createdAt.getTime();
		Object.freeze(this);
	}

	static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
		return WalletLedgerEntry.rehydrate(props);
	}

	static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
		if (
			!isUuid(props.id) ||
			!isUuid(props.walletId) ||
			!isUuid(props.transactionId) ||
			!isValidDate(props.createdAt) ||
			!['CREDIT', 'DEBIT'].includes(props.direction) ||
			!(props.amount instanceof Money) ||
			!(props.balanceBefore instanceof Money) ||
			!(props.balanceAfter instanceof Money) ||
			!props.amount.isPositive() ||
			props.balanceBefore.isNegative() ||
			props.balanceAfter.isNegative()
		) {
			throw new InconsistentLedgerEntryError(
				'Invalid ledger entry state',
			);
		}
		const expected =
			props.direction === 'CREDIT'
				? props.balanceBefore.add(props.amount)
				: props.balanceBefore.subtract(props.amount);
		if (!expected.equals(props.balanceAfter)) {
			throw new InconsistentLedgerEntryError(
				'Ledger arithmetic must balance',
			);
		}
		return new WalletLedgerEntry(props);
	}

	get createdAt(): Date {
		return new Date(this.#createdAt);
	}
}
