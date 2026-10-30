import { Money } from '../../financial/public/index.js';
import type {
	MoneyProps,
	LedgerDirection,
} from '../../financial/public/index.js';
import type { WagerTransactionKind } from '../domain/wager-types.js';
import { IntegrationEvent, eventText, eventUuid } from './integration-event.js';
import type { IntegrationEventProps } from './integration-event.js';

export interface WagerEventData {
	readonly transactionId: string;
	readonly providerId: string;
	readonly externalTransactionId: string;
	readonly playerId: string;
	readonly walletId: string;
	readonly kind: WagerTransactionKind;
	readonly money: Readonly<MoneyProps>;
}

export interface WagerTransactionProcessedData extends WagerEventData {
	readonly status: 'PROCESSED';
	readonly referenceTransactionId?: string;
}
export interface WagerTransactionRejectedData extends WagerEventData {
	readonly status: 'REJECTED';
	readonly failureCode: string;
}
export interface WagerTransactionPendingReferenceData extends WagerEventData {
	readonly status: 'PENDING_REFERENCE';
	readonly referenceExternalTransactionId: string;
}
export interface WalletBalanceChangedData {
	readonly walletId: string;
	readonly transactionId: string;
	readonly direction: LedgerDirection;
	readonly money: Readonly<MoneyProps>;
	readonly balanceBefore: Readonly<MoneyProps>;
	readonly balanceAfter: Readonly<MoneyProps>;
	readonly walletVersion: number;
}

function eventMoney(value: MoneyProps): Readonly<MoneyProps> {
	return Object.freeze(Money.create(value).toProps());
}

function wagerData(data: WagerEventData): WagerEventData {
	if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(data.kind))
		throw new Error('Invalid event kind');
	return {
		transactionId: eventUuid(data.transactionId),
		providerId: eventText(data.providerId),
		externalTransactionId: eventText(data.externalTransactionId),
		playerId: eventText(data.playerId),
		walletId: eventUuid(data.walletId),
		kind: data.kind,
		money: eventMoney(data.money),
	};
}

function assertFact(
	aggregateId: string,
	expected: string,
	status: string,
	expectedStatus: string,
): void {
	if (eventUuid(aggregateId) !== expected || status !== expectedStatus)
		throw new Error('Invalid event fact');
}

export class WagerTransactionProcessed extends IntegrationEvent<
	WagerTransactionProcessedData,
	'WagerTransactionProcessed'
> {
	readonly eventType = 'WagerTransactionProcessed';
	readonly version = 1;
	private constructor(
		props: IntegrationEventProps<WagerTransactionProcessedData>,
	) {
		super(props);
		Object.freeze(this);
	}
	static create(
		props: IntegrationEventProps<WagerTransactionProcessedData>,
	): WagerTransactionProcessed {
		const data = wagerData(props.data);
		assertFact(
			props.aggregateId,
			data.transactionId,
			props.data.status,
			'PROCESSED',
		);
		const reference = props.data.referenceTransactionId;
		if (
			(data.kind === 'REFUND' || data.kind === 'ROLLBACK') &&
			reference === undefined
		)
			throw new Error('Processed reversal requires reference');
		return new WagerTransactionProcessed({
			...props,
			data: {
				...data,
				status: 'PROCESSED',
				...(reference === undefined
					? {}
					: { referenceTransactionId: eventUuid(reference) }),
			},
		});
	}
}

export class WagerTransactionRejected extends IntegrationEvent<
	WagerTransactionRejectedData,
	'WagerTransactionRejected'
> {
	readonly eventType = 'WagerTransactionRejected';
	readonly version = 1;
	private constructor(
		props: IntegrationEventProps<WagerTransactionRejectedData>,
	) {
		super(props);
		Object.freeze(this);
	}
	static create(
		props: IntegrationEventProps<WagerTransactionRejectedData>,
	): WagerTransactionRejected {
		const data = wagerData(props.data);
		assertFact(
			props.aggregateId,
			data.transactionId,
			props.data.status,
			'REJECTED',
		);
		return new WagerTransactionRejected({
			...props,
			data: {
				...data,
				status: 'REJECTED',
				failureCode: eventText(props.data.failureCode),
			},
		});
	}
}

export class WagerTransactionPendingReference extends IntegrationEvent<
	WagerTransactionPendingReferenceData,
	'WagerTransactionPendingReference'
> {
	readonly eventType = 'WagerTransactionPendingReference';
	readonly version = 1;
	private constructor(
		props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
	) {
		super(props);
		Object.freeze(this);
	}
	static create(
		props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
	): WagerTransactionPendingReference {
		const data = wagerData(props.data);
		assertFact(
			props.aggregateId,
			data.transactionId,
			props.data.status,
			'PENDING_REFERENCE',
		);
		return new WagerTransactionPendingReference({
			...props,
			data: {
				...data,
				status: 'PENDING_REFERENCE',
				referenceExternalTransactionId: eventText(
					props.data.referenceExternalTransactionId,
				),
			},
		});
	}
}

export class WalletBalanceChanged extends IntegrationEvent<
	WalletBalanceChangedData,
	'WalletBalanceChanged'
> {
	readonly eventType = 'WalletBalanceChanged';
	readonly version = 1;
	private constructor(
		props: IntegrationEventProps<WalletBalanceChangedData>,
	) {
		super(props);
		Object.freeze(this);
	}
	static create(
		props: IntegrationEventProps<WalletBalanceChangedData>,
	): WalletBalanceChanged {
		const input = props.data;
		const data = {
			walletId: eventUuid(input.walletId),
			transactionId: eventUuid(input.transactionId),
			direction: input.direction,
			money: eventMoney(input.money),
			balanceBefore: eventMoney(input.balanceBefore),
			balanceAfter: eventMoney(input.balanceAfter),
			walletVersion: input.walletVersion,
		};
		assertFact(props.aggregateId, data.walletId, 'CHANGED', 'CHANGED');
		if (
			!Number.isInteger(data.walletVersion) ||
			data.walletVersion < 2 ||
			data.walletVersion > 2147483647 ||
			!['DEBIT', 'CREDIT'].includes(data.direction)
		)
			throw new Error('Invalid wallet event');
		const money = Money.create(data.money);
		const before = Money.create(data.balanceBefore);
		const after = Money.create(data.balanceAfter);
		const expected =
			data.direction === 'DEBIT'
				? before.subtract(money)
				: before.add(money);
		if (!money.isPositive() || !expected.equals(after))
			throw new Error('Invalid event balance change');
		return new WalletBalanceChanged({ ...props, data });
	}
}

export type WagerIntegrationEvent =
	| WagerTransactionProcessed
	| WagerTransactionRejected
	| WagerTransactionPendingReference
	| WalletBalanceChanged;

export interface OutboxRepository {
	append(events: readonly WagerIntegrationEvent[]): Promise<void>;
}
