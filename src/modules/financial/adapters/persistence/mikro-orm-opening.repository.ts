import { WagerTransactionRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import type {
	OpeningTransaction,
	OpeningTransactionRepository,
} from '../../public/persistence.js';

export class MikroOrmOpeningRepository implements OpeningTransactionRepository {
	constructor(private readonly session: TransactionSession) {}

	async insert(record: OpeningTransaction): Promise<void> {
		await this.session.em.insert(WagerTransactionRow, {
			id: record.id,
			walletId: record.walletId,
			playerId: record.playerId,
			kind: 'OPENING',
			status: 'PROCESSED',
			amount: record.money.toProps().amount,
			currency: record.money.currency,
			createdAt: record.createdAt,
			updatedAt: record.createdAt,
			processedAt: record.createdAt,
		});
	}
}
