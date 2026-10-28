import type { Money } from './money.js';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface BalanceChange {
	readonly walletId: string;
	readonly direction: LedgerDirection;
	readonly amount: Money;
	readonly balanceBefore: Money;
	readonly balanceAfter: Money;
}
