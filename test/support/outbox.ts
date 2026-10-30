import {
	WagerTransactionProcessed,
	WagerTransactionRejected,
	WagerTransactionPendingReference,
	WalletBalanceChanged,
} from '../../src/modules/wagering/public/events.js';
import type { WagerIntegrationEvent } from '../../src/modules/wagering/public/events.js';
import type {
	OutboxClaim,
	OutboxEvent,
} from '../../src/platform/messaging/outbox.js';

export function eventRecord(event: WagerIntegrationEvent): OutboxEvent {
	return {
		eventId: event.eventId,
		eventType: event.eventType,
		eventVersion: event.version,
		aggregateId: event.aggregateId,
		correlationId: event.correlationId,
		causationId: event.causationId ?? null,
		occurredAt: event.occurredAt,
		payload: event.toJSON(),
	};
}

export function exampleEvents(): WagerIntegrationEvent[] {
	const transactionId = crypto.randomUUID();
	const walletId = crypto.randomUUID();
	const props = {
		aggregateId: transactionId,
		correlationId: transactionId,
		causationId: 'request-1',
		occurredAt: new Date('2026-10-29T12:00:00.000Z'),
	};
	const data = {
		transactionId,
		walletId,
		playerId: 'player',
		providerId: 'provider',
		externalTransactionId: 'external',
		kind: 'BET' as const,
		money: { amount: '9007199254740993.01', currency: 'BRL' },
	};
	return [
		WagerTransactionProcessed.create({
			...props,
			eventId: crypto.randomUUID(),
			data: { ...data, status: 'PROCESSED' },
		}),
		WagerTransactionRejected.create({
			...props,
			eventId: crypto.randomUUID(),
			data: {
				...data,
				status: 'REJECTED',
				failureCode: 'BET_INSUFFICIENT_BALANCE',
			},
		}),
		WagerTransactionPendingReference.create({
			...props,
			eventId: crypto.randomUUID(),
			data: {
				...data,
				kind: 'REFUND',
				status: 'PENDING_REFERENCE',
				referenceExternalTransactionId: 'missing',
			},
		}),
		WalletBalanceChanged.create({
			...props,
			eventId: crypto.randomUUID(),
			aggregateId: walletId,
			data: {
				walletId,
				transactionId,
				direction: 'DEBIT',
				money: data.money,
				balanceBefore: {
					amount: '9007199254740994.01',
					currency: 'BRL',
				},
				balanceAfter: { amount: '1.00', currency: 'BRL' },
				walletVersion: 2,
			},
		}),
	];
}

export function exampleClaim(): OutboxClaim {
	const event = exampleEvents()[0];
	if (event === undefined) throw new Error('Missing fixture event');
	return {
		...eventRecord(event),
		token: crypto.randomUUID(),
		claimedUntil: new Date(Date.now() + 30000),
		attempts: 1,
		recovered: false,
	};
}
