import type { MoneyProps } from '../domain/money.js';

export interface CreateWalletCommand {
	readonly playerId: string;
	readonly initialBalance: MoneyProps;
}

export interface WalletResult {
	readonly id: string;
	readonly playerId: string;
	readonly currency: string;
	readonly balance: MoneyProps;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface WalletReconciliationResult {
	readonly walletId: string;
	readonly storedBalance: MoneyProps;
	readonly calculatedBalance: MoneyProps;
	readonly difference: MoneyProps;
	readonly consistent: boolean;
	readonly checkedEntries: number;
}

export interface ReconciliationDiagnostics {
	divergence(walletId: string): void;
}

export class FinancialApplicationError extends Error {
	constructor(
		readonly code:
			| 'WALLET_NOT_FOUND'
			| 'WALLET_ALREADY_EXISTS'
			| 'INVALID_WALLET_INPUT'
			| 'INVALID_CURSOR',
	) {
		super(code);
		this.name = 'FinancialApplicationError';
	}
}
