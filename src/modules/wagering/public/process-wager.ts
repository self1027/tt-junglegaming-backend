import type { MoneyProps } from '../../financial/public/index.js';
import type { WagerTransactionKind } from '../domain/wager-types.js';

export interface ProcessWagerCommand {
	readonly providerId: string;
	readonly externalTransactionId: string;
	readonly idempotencyKey: string;
	readonly playerId: string;
	readonly roundId: string;
	readonly gameId: string;
	readonly kind: WagerTransactionKind;
	readonly amount: MoneyProps;
	readonly referenceExternalTransactionId?: string | null | undefined;
}

interface WagerResultIdentity {
	readonly transactionId: string;
	readonly externalTransactionId: string;
	readonly walletId: string;
	readonly idempotentReplay: boolean;
}

export type ProcessWagerResult = WagerResultIdentity &
	(
		| { readonly status: 'PROCESSED'; readonly balance: MoneyProps }
		| {
				readonly status: 'REJECTED' | 'FAILED';
				readonly failureCode: string;
		  }
		| {
				readonly status: 'PENDING_REFERENCE';
				readonly pendingReference: {
					readonly reason: 'NOT_FOUND';
					readonly externalTransactionId: string;
				};
		  }
		| {
				readonly status: 'PENDING';
				readonly pendingReference: {
					readonly reason: 'NOT_PROCESSED';
					readonly externalTransactionId: string;
					readonly transactionId: string;
					readonly status: 'PENDING' | 'PENDING_REFERENCE';
				};
		  }
	);

export type WagerApplicationErrorCode =
	| 'IDEMPOTENCY_CONFLICT'
	| 'EXTERNAL_TRANSACTION_CONFLICT'
	| 'IDEMPOTENCY_IN_PROGRESS'
	| 'WALLET_NOT_FOUND';

export class WagerApplicationError extends Error {
	constructor(
		readonly code: WagerApplicationErrorCode,
		readonly transactionId?: string,
		readonly samePayload?: boolean,
	) {
		super(code);
		this.name = 'WagerApplicationError';
	}
}
