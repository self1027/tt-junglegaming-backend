import { WagerTransactionRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import type {
	ProcessedWagerRecord,
	WagerTransactionRepository,
} from '../../public/persistence.js';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
	constructor(private readonly session: TransactionSession) {}

	async insertProcessed(record: ProcessedWagerRecord): Promise<void> {
		await this.session.em.insert(WagerTransactionRow, {
			id: record.id,
			walletId: record.walletId,
			playerId: record.playerId,
			providerId: record.providerId,
			externalTransactionId: record.externalTransactionId,
			idempotencyKey: record.idempotencyKey,
			payloadHash: record.payloadHash,
			roundId: record.roundId,
			gameId: record.gameId,
			kind: record.kind,
			status: 'PROCESSED',
			amount: record.money.toProps().amount,
			currency: record.money.currency,
			referenceExternalTransactionId:
				record.referenceExternalTransactionId,
			referenceTransactionId: record.referenceTransactionId,
			createdAt: record.createdAt,
			updatedAt: record.processedAt,
			processedAt: record.processedAt,
		});
	}
}
