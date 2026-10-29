import { LockMode } from '@mikro-orm/core';
import { IdempotencyRecordRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import type {
	IdempotencyClaim,
	IdempotencyRepository,
} from '../../public/persistence.js';
import type { ProcessWagerResult } from '../../public/process-wager.js';
import { wagerResultFromJson } from './mappers.js';

export class MikroOrmIdempotencyRepository implements IdempotencyRepository {
	constructor(private readonly session: TransactionSession) {}

	async lockResult(
		scope: string,
		key: string,
		payloadHash: string,
		transactionId: string,
	): Promise<ProcessWagerResult | undefined> {
		const row = await this.session.em.findOne(
			IdempotencyRecordRow,
			{
				scope,
				idempotencyKey: key,
				payloadHash,
				transactionId,
				status: 'COMPLETED',
			},
			{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
		);
		return row === null
			? undefined
			: wagerResultFromJson(row.originalResult);
	}

	async resolvePending(
		scope: string,
		key: string,
		payloadHash: string,
		result: ProcessWagerResult,
	): Promise<void> {
		if (
			result.idempotentReplay ||
			!['PROCESSED', 'REJECTED'].includes(result.status)
		)
			throw new Error('Invalid terminal resolution');
		const changed = await this.session.em.execute<{ id: string }[]>(
			`
			update idempotency_records set original_result = ?::jsonb, updated_at = clock_timestamp()
			where scope = ? and idempotency_key = ? and payload_hash = ? and status = 'COMPLETED'
				and transaction_id = ? and original_result->>'transactionId' = ?
				and original_result->>'walletId' = ? and original_result->>'externalTransactionId' = ?
				and original_result->>'status' in ('PENDING', 'PENDING_REFERENCE') returning id
		`,
			[
				JSON.stringify(result),
				scope,
				key,
				payloadHash,
				result.transactionId,
				result.transactionId,
				result.walletId,
				result.externalTransactionId,
			],
		);
		if (changed.length !== 1)
			throw new Error('Idempotency resolution conflict');
	}

	async claim(
		scope: string,
		key: string,
		payloadHash: string,
	): Promise<IdempotencyClaim> {
		const em = this.session.em;
		const inserted = await em.execute<{ id: string }[]>(
			`insert into idempotency_records (scope, idempotency_key, payload_hash)
			values (?, ?, ?) on conflict (scope, idempotency_key) do nothing returning id`,
			[scope, key, payloadHash],
		);
		if (inserted.length === 1) return { type: 'CLAIMED' };
		const row = await em.findOneOrFail(
			IdempotencyRecordRow,
			{ scope, idempotencyKey: key },
			{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
		);
		return {
			type: 'EXISTING',
			payloadHash: row.payloadHash,
			result:
				row.status === 'COMPLETED'
					? wagerResultFromJson(row.originalResult)
					: undefined,
		};
	}

	async complete(
		scope: string,
		key: string,
		payloadHash: string,
		result: ProcessWagerResult,
	): Promise<void> {
		if (result.idempotentReplay)
			throw new Error('Cannot store a replay as the original result');
		const affected = await this.session.em.nativeUpdate(
			IdempotencyRecordRow,
			{ scope, idempotencyKey: key, payloadHash, status: 'IN_PROGRESS' },
			{
				status: 'COMPLETED',
				transactionId: result.transactionId,
				originalResult: { ...result },
				updatedAt: new Date(),
			},
		);
		if (affected !== 1) throw new Error('Idempotency completion conflict');
	}
}
