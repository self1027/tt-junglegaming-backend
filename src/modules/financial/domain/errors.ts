export class InvalidMoneyError extends Error {
	override readonly name = 'InvalidMoneyError';
}

export class CurrencyMismatchError extends Error {
	override readonly name = 'CurrencyMismatchError';
}

export class InsufficientBalanceError extends Error {
	override readonly name = 'InsufficientBalanceError';
}

export class InvalidWalletStateError extends Error {
	override readonly name = 'InvalidWalletStateError';
}

export class InconsistentLedgerEntryError extends Error {
	override readonly name = 'InconsistentLedgerEntryError';
}
