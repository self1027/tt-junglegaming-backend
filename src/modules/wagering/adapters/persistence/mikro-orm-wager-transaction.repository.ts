import { WagerTransactionRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import type {
	ProcessedWagerRecord,
	WagerTransactionRepository,
} from '../../public/persistence.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WagerReversalKind } from '../../domain/wager-types.js';
import { wagerToDomain, wagerToRow } from './mappers.js';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
	constructor(private readonly session: TransactionSession) {}

	async lockExternalIdentity(
		providerId: string,
		externalTransactionId: string,
	): Promise<void> {
		await this.session.em.execute(
			'select pg_advisory_xact_lock(hashtextextended(?, 0))',
			[
				JSON.stringify([
					'wagering-external-v1',
					providerId,
					externalTransactionId,
				]),
			],
		);
	}

	async findById(id: string): Promise<WagerTransaction | undefined> {
		const row = await this.session.em.findOne(
			WagerTransactionRow,
			{ id, kind: { $ne: 'OPENING' } },
			{ refresh: true },
		);
		return row === null ? undefined : wagerToDomain(row);
	}

	async findByExternalIdentity(
		providerId: string,
		externalTransactionId: string,
	): Promise<WagerTransaction | undefined> {
		const row = await this.session.em.findOne(
			WagerTransactionRow,
			{ providerId, externalTransactionId, kind: { $ne: 'OPENING' } },
			{ refresh: true },
		);
		return row === null ? undefined : wagerToDomain(row);
	}

	async insert(transaction: WagerTransaction): Promise<void> {
		await this.session.em.insert(
			WagerTransactionRow,
			wagerToRow(transaction),
		);
	}

	async save(transaction: WagerTransaction): Promise<void> {
		const affected = await this.session.em.nativeUpdate(
			WagerTransactionRow,
			{
				id: transaction.id,
				status: { $in: ['PENDING', 'PENDING_REFERENCE'] },
			},
			{
				status: transaction.status,
				referenceTransactionId:
					transaction.referenceTransactionId ?? null,
				failureCode: transaction.failureCode ?? null,
				processedAt: transaction.processedAt ?? null,
				updatedAt: new Date(),
			},
		);
		if (affected !== 1) throw new Error('Wager state conflict');
	}

	async findProcessedReversalKinds(
		referenceTransactionId: string,
	): Promise<readonly WagerReversalKind[]> {
		const rows = await this.session.em.find(
			WagerTransactionRow,
			{
				referenceTransactionId,
				status: 'PROCESSED',
				kind: { $in: ['REFUND', 'ROLLBACK'] },
			},
			{ refresh: true },
		);
		return rows.map(row => {
			if (row.kind !== 'REFUND' && row.kind !== 'ROLLBACK')
				throw new Error('Invalid reversal kind');
			return row.kind;
		});
	}

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
