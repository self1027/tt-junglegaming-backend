export class InvalidWagerOperationError extends Error {
	override readonly name = 'InvalidWagerOperationError';
}

export class InvalidWagerStateError extends Error {
	override readonly name = 'InvalidWagerStateError';
}

export class ForbiddenWagerTransitionError extends Error {
	override readonly name = 'ForbiddenWagerTransitionError';
}

export class IncompatibleWagerReferenceError extends Error {
	override readonly name = 'IncompatibleWagerReferenceError';
}

export class InvalidWagerReversalError extends Error {
	override readonly name = 'InvalidWagerReversalError';
}

export class WagerFinancialInvariantError extends Error {
	override readonly name = 'WagerFinancialInvariantError';
}

export class WagerDecisionRequiredError extends Error {
	override readonly name = 'WagerDecisionRequiredError';
}
