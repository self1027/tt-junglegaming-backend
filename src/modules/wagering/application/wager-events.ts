import type { BalanceChange, Wallet } from '../../financial/public/index.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import {
	WagerTransactionProcessed,
	WagerTransactionRejected,
	WagerTransactionPendingReference,
	WalletBalanceChanged,
} from '../public/events.js';
import type { WagerIntegrationEvent } from '../public/events.js';

export function wagerEvents(
	transaction: WagerTransaction,
	wallet: Wallet,
	change: BalanceChange | undefined,
	at: Date,
): readonly WagerIntegrationEvent[] {
	const context = {
		aggregateId: transaction.id,
		correlationId: transaction.id,
		occurredAt: at,
	};
	const data = {
		transactionId: transaction.id,
		providerId: transaction.providerId,
		externalTransactionId: transaction.externalTransactionId,
		playerId: transaction.playerId,
		walletId: transaction.walletId,
		kind: transaction.kind,
		money: transaction.money.toProps(),
	};
	const events: WagerIntegrationEvent[] = [];
	switch (transaction.status) {
		case 'PROCESSED':
			events.push(
				WagerTransactionProcessed.create({
					...context,
					eventId: crypto.randomUUID(),
					data: {
						...data,
						status: 'PROCESSED',
						...(transaction.referenceTransactionId === undefined
							? {}
							: {
									referenceTransactionId:
										transaction.referenceTransactionId,
								}),
					},
				}),
			);
			if (change !== undefined)
				events.push(
					WalletBalanceChanged.create({
						...context,
						aggregateId: wallet.id,
						eventId: crypto.randomUUID(),
						data: {
							walletId: wallet.id,
							transactionId: transaction.id,
							direction: change.direction,
							money: change.amount.toProps(),
							balanceBefore: change.balanceBefore.toProps(),
							balanceAfter: change.balanceAfter.toProps(),
							walletVersion: wallet.version,
						},
					}),
				);
			break;
		case 'REJECTED':
			if (transaction.failureCode === undefined)
				throw new Error('Missing rejection code');
			events.push(
				WagerTransactionRejected.create({
					...context,
					eventId: crypto.randomUUID(),
					data: {
						...data,
						status: 'REJECTED',
						failureCode: transaction.failureCode,
					},
				}),
			);
			break;
		case 'PENDING_REFERENCE':
			if (transaction.referenceExternalTransactionId === undefined)
				throw new Error('Missing reference identity');
			events.push(
				WagerTransactionPendingReference.create({
					...context,
					eventId: crypto.randomUUID(),
					data: {
						...data,
						status: 'PENDING_REFERENCE',
						referenceExternalTransactionId:
							transaction.referenceExternalTransactionId,
					},
				}),
			);
			break;
		case 'PENDING':
		case 'FAILED':
			break;
	}
	return events;
}
