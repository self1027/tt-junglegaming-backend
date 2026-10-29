import type { WageringUnitOfWork } from '../public/persistence.js';
import { WagerApplicationError } from '../public/process-wager.js';

export class QueryWagerUseCase {
	constructor(private readonly unitOfWork: WageringUnitOfWork) {}

	async execute(
		identity:
			| { transactionId: string }
			| { providerId: string; externalTransactionId: string },
	): Promise<Record<string, unknown>> {
		return this.unitOfWork.execute(
			async context => {
				const transaction =
					'transactionId' in identity
						? await context.transactions.findById(
								identity.transactionId,
							)
						: await context.transactions.findByExternalIdentity(
								identity.providerId,
								identity.externalTransactionId,
							);
				if (transaction === undefined)
					throw new WagerApplicationError('TRANSACTION_NOT_FOUND');
				return {
					transactionId: transaction.id,
					providerId: transaction.providerId,
					externalTransactionId: transaction.externalTransactionId,
					walletId: transaction.walletId,
					playerId: transaction.playerId,
					roundId: transaction.roundId,
					gameId: transaction.gameId,
					kind: transaction.kind,
					money: transaction.money.toProps(),
					status: transaction.status,
					referenceExternalTransactionId:
						transaction.referenceExternalTransactionId,
					referenceTransactionId: transaction.referenceTransactionId,
					failureCode: transaction.failureCode,
					createdAt: transaction.createdAt.toISOString(),
					processedAt: transaction.processedAt?.toISOString(),
				};
			},
			{ readOnly: true },
		);
	}
}
