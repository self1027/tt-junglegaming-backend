import { LockMode } from '@mikro-orm/core';
import { InboxMessageRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import { InboxPayloadConflict } from '../../public/inbox.js';
import type { InboxDelivery, InboxRepository } from '../../public/inbox.js';

export class MikroOrmInboxRepository implements InboxRepository {
	constructor(private readonly session: TransactionSession) {}

	async claim(delivery: InboxDelivery): Promise<'CLAIMED' | 'PROCESSED'> {
		const em = this.session.em;
		const inserted = await em.execute<{ id: string }[]>(
			`insert into inbox_messages (consumer_name, message_id, payload_hash, attempts)
			values (?, ?, ?, 1) on conflict (consumer_name, message_id) do nothing returning id`,
			[delivery.consumerName, delivery.messageId, delivery.payloadHash],
		);
		if (inserted.length === 1) return 'CLAIMED';
		const row = await em.findOneOrFail(
			InboxMessageRow,
			{
				consumerName: delivery.consumerName,
				messageId: delivery.messageId,
			},
			{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
		);
		if (row.payloadHash !== delivery.payloadHash)
			throw new InboxPayloadConflict();
		await em.nativeUpdate(
			InboxMessageRow,
			{ id: row.id },
			{
				attempts: row.attempts + 1,
				updatedAt: new Date(),
			},
		);
		return row.status === 'PROCESSED' ? 'PROCESSED' : 'CLAIMED';
	}

	async complete(delivery: InboxDelivery): Promise<void> {
		const at = new Date();
		const affected = await this.session.em.nativeUpdate(
			InboxMessageRow,
			{
				consumerName: delivery.consumerName,
				messageId: delivery.messageId,
				payloadHash: delivery.payloadHash,
				status: 'RECEIVED',
			},
			{
				status: 'PROCESSED',
				processedAt: at,
				updatedAt: at,
				lastError: null,
			},
		);
		if (affected !== 1) throw new Error('Inbox completion conflict');
	}
}
