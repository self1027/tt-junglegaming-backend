import {
	WalletBalanceChanged,
	WagerTransactionProcessed,
	WagerTransactionRejected,
	WagerTransactionPendingReference,
} from '../../public/events.js';
import type { MoneyProps } from '../../../financial/public/index.js';
import type { WagerTransactionKind } from '../../public/index.js';
import type { OutboxEvent } from '../../../../platform/messaging/outbox.js';
import { InvalidOutboxEvent } from '../../../../platform/messaging/outbox.js';

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new InvalidOutboxEvent();
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== 'string') throw new InvalidOutboxEvent();
	return value;
}
function money(value: unknown): MoneyProps {
	const data = object(value);
	return { amount: text(data.amount), currency: text(data.currency) };
}

/** JSONB loses key order. Sort recursively without changing any historical value. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map((item: unknown) => stableJson(item)).join(',')}]`;
	if (typeof value === 'object' && value !== null)
		return `{${Object.keys(value)
			.sort()
			.map(
				key =>
					`${JSON.stringify(key)}:${stableJson(object(value)[key])}`,
			)
			.join(',')}}`;
	const json: string | undefined =
		value === undefined ? undefined : JSON.stringify(value);
	if (json === undefined) throw new InvalidOutboxEvent();
	return json;
}

export function persistedEvent(event: OutboxEvent): {
	body: string;
	groupId: string;
	deduplicationId: string;
} {
	try {
		const envelope = event.payload;
		const data = object(envelope.data);
		const props = {
			eventId: text(envelope.eventId),
			aggregateId: text(envelope.aggregateId),
			correlationId: text(envelope.correlationId),
			occurredAt: new Date(text(envelope.occurredAt)),
			...(envelope.causationId === undefined
				? {}
				: { causationId: text(envelope.causationId) }),
		};
		let validated;
		if (envelope.eventType === 'WalletBalanceChanged') {
			if (data.direction !== 'DEBIT' && data.direction !== 'CREDIT')
				throw new InvalidOutboxEvent();
			if (typeof data.walletVersion !== 'number')
				throw new InvalidOutboxEvent();
			validated = WalletBalanceChanged.create({
				...props,
				data: {
					walletId: text(data.walletId),
					transactionId: text(data.transactionId),
					direction: data.direction,
					money: money(data.money),
					balanceBefore: money(data.balanceBefore),
					balanceAfter: money(data.balanceAfter),
					walletVersion: data.walletVersion,
				},
			});
		} else {
			const kind = text(data.kind);
			if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind))
				throw new InvalidOutboxEvent();
			const common = {
				transactionId: text(data.transactionId),
				providerId: text(data.providerId),
				externalTransactionId: text(data.externalTransactionId),
				playerId: text(data.playerId),
				walletId: text(data.walletId),
				kind: kind as WagerTransactionKind,
				money: money(data.money),
			};
			switch (envelope.eventType) {
				case 'WagerTransactionProcessed':
					if (data.status !== 'PROCESSED')
						throw new InvalidOutboxEvent();
					validated = WagerTransactionProcessed.create({
						...props,
						data: {
							...common,
							status: data.status,
							...(data.referenceTransactionId === undefined
								? {}
								: {
										referenceTransactionId: text(
											data.referenceTransactionId,
										),
									}),
						},
					});
					break;
				case 'WagerTransactionRejected':
					if (data.status !== 'REJECTED')
						throw new InvalidOutboxEvent();
					validated = WagerTransactionRejected.create({
						...props,
						data: {
							...common,
							status: data.status,
							failureCode: text(data.failureCode),
						},
					});
					break;
				case 'WagerTransactionPendingReference':
					if (data.status !== 'PENDING_REFERENCE')
						throw new InvalidOutboxEvent();
					validated = WagerTransactionPendingReference.create({
						...props,
						data: {
							...common,
							status: data.status,
							referenceExternalTransactionId: text(
								data.referenceExternalTransactionId,
							),
						},
					});
					break;
				default:
					throw new InvalidOutboxEvent();
			}
		}
		const body = stableJson(envelope);
		if (
			envelope.version !== event.eventVersion ||
			props.eventId !== event.eventId ||
			envelope.eventType !== event.eventType ||
			props.aggregateId !== event.aggregateId ||
			props.correlationId !== event.correlationId ||
			(props.causationId ?? null) !== event.causationId ||
			props.occurredAt.getTime() !== event.occurredAt.getTime() ||
			body !== stableJson(validated.toJSON())
		)
			throw new InvalidOutboxEvent();
		return {
			body,
			groupId: text(data.walletId),
			deduplicationId: event.eventId,
		};
	} catch {
		throw new InvalidOutboxEvent();
	}
}
