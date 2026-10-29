import { OutboxMessageRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import {
	WagerTransactionProcessed,
	WagerTransactionRejected,
	WagerTransactionPendingReference,
	WalletBalanceChanged,
} from '../../public/events.js';
import type {
	OutboxRepository,
	WagerIntegrationEvent,
} from '../../public/events.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
	constructor(private readonly session: TransactionSession) {}

	async append(events: readonly WagerIntegrationEvent[]): Promise<void> {
		const em = this.session.em;
		for (const event of events) {
			if (!(
				event instanceof WagerTransactionProcessed ||
				event instanceof WagerTransactionRejected ||
				event instanceof WagerTransactionPendingReference ||
				event instanceof WalletBalanceChanged
			))
				throw new Error(
					'Outbox requires a validated integration event',
				);
			await em.insert(OutboxMessageRow, {
				eventId: event.eventId,
				aggregateId: event.aggregateId,
				eventType: event.eventType,
				eventVersion: event.version,
				correlationId: event.correlationId,
				causationId: event.causationId ?? null,
				occurredAt: event.occurredAt,
				payload: event.toJSON(),
			});
		}
	}
}
