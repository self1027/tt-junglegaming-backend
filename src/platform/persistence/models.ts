import { defineEntity, p } from '@mikro-orm/core';
import { ExactNumericType } from './exact-numeric.type.js';

const id = p
	.uuid()
	.primary()
	.defaultRaw('gen_random_uuid()')
	.onCreate(() => crypto.randomUUID());
const timestamp = p.datetime().columnType('timestamptz');
const createdAt = timestamp.defaultRaw('current_timestamp');
// pg returns NUMERIC as text; string comparison also preserves changes beyond 53 bits.
const money = p.type(ExactNumericType).$type<string>();
const text = p.text();

export const WalletRow = defineEntity({
	name: 'WalletRow',
	tableName: 'wallets',
	properties: {
		id,
		playerId: text,
		currency: p.string().length(3),
		balance: money,
		version: p.integer().default(1),
		createdAt,
		updatedAt: createdAt,
	},
	uniques: [
		{
			name: 'wallets_player_currency_unique',
			properties: ['playerId', 'currency'],
		},
	],
});

export const WagerTransactionRow = defineEntity({
	name: 'WagerTransactionRow',
	tableName: 'wager_transactions',
	properties: {
		id,
		providerId: text.nullable(),
		externalTransactionId: text.nullable(),
		idempotencyKey: text.nullable(),
		payloadHash: text.nullable(),
		walletId: p.manyToOne(WalletRow).mapToPk().fieldName('wallet_id'),
		playerId: text,
		roundId: text.nullable(),
		gameId: text.nullable(),
		kind: text.$type<
			'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK'
		>(),
		status: text
			.$type<
				| 'PENDING'
				| 'PENDING_REFERENCE'
				| 'PROCESSED'
				| 'REJECTED'
				| 'FAILED'
			>()
			.default('PENDING'),
		amount: money,
		currency: p.string().length(3),
		referenceExternalTransactionId: text.nullable(),
		referenceTransactionId: p.uuid().nullable(),
		failureCode: text.nullable(),
		attempts: p.integer().default(0),
		nextAttemptAt: timestamp.nullable(),
		lastAttemptAt: timestamp.nullable(),
		claimToken: p.uuid().nullable(),
		claimedBy: text.nullable(),
		claimedUntil: timestamp.nullable(),
		lastError: text.nullable(),
		createdAt,
		updatedAt: createdAt,
		processedAt: timestamp.nullable(),
	},
	uniques: [
		{
			name: 'wager_external_identity_unique',
			properties: ['providerId', 'externalTransactionId'],
		},
	],
});

export const WalletLedgerEntryRow = defineEntity({
	name: 'WalletLedgerEntryRow',
	tableName: 'wallet_ledger_entries',
	properties: {
		id,
		walletId: p.manyToOne(WalletRow).mapToPk().fieldName('wallet_id'),
		transactionId: p
			.manyToOne(WagerTransactionRow)
			.mapToPk()
			.fieldName('transaction_id'),
		direction: text.$type<'DEBIT' | 'CREDIT'>(),
		currency: p.string().length(3),
		amount: money,
		balanceBefore: money,
		balanceAfter: money,
		createdAt,
	},
	uniques: [
		{
			name: 'ledger_transaction_wallet_unique',
			properties: ['transactionId', 'walletId'],
		},
	],
});

export const InboxMessageRow = defineEntity({
	name: 'InboxMessageRow',
	tableName: 'inbox_messages',
	properties: {
		id,
		consumerName: text,
		messageId: text,
		payloadHash: text,
		status: text.$type<'RECEIVED' | 'PROCESSED'>().default('RECEIVED'),
		attempts: p.integer().default(0),
		lastError: text.nullable(),
		receivedAt: createdAt,
		updatedAt: createdAt,
		processedAt: timestamp.nullable(),
	},
	uniques: [
		{
			name: 'inbox_consumer_message_unique',
			properties: ['consumerName', 'messageId'],
		},
	],
});

export const OutboxMessageRow = defineEntity({
	name: 'OutboxMessageRow',
	tableName: 'outbox_messages',
	properties: {
		id,
		eventId: p.uuid().unique('outbox_event_id_unique'),
		aggregateId: p.uuid(),
		eventType: text,
		eventVersion: p.integer(),
		correlationId: text,
		causationId: text.nullable(),
		payload: p.json<Record<string, unknown>>().columnType('jsonb'),
		status: text.$type<'PENDING' | 'PUBLISHED'>().default('PENDING'),
		attempts: p.integer().default(0),
		lastError: text.nullable(),
		occurredAt: timestamp,
		createdAt,
		nextAttemptAt: createdAt,
		publishedAt: timestamp.nullable(),
		claimToken: p.uuid().nullable(),
		claimedBy: text.nullable(),
		claimedUntil: timestamp.nullable(),
	},
});

export const IdempotencyRecordRow = defineEntity({
	name: 'IdempotencyRecordRow',
	tableName: 'idempotency_records',
	properties: {
		id,
		scope: text,
		idempotencyKey: text,
		payloadHash: text,
		status: text
			.$type<'IN_PROGRESS' | 'COMPLETED'>()
			.default('IN_PROGRESS'),
		transactionId: p
			.manyToOne(WagerTransactionRow)
			.mapToPk()
			.fieldName('transaction_id')
			.nullable(),
		originalResult: p
			.json<Record<string, unknown>>()
			.columnType('jsonb')
			.nullable(),
		createdAt,
		updatedAt: createdAt,
	},
	uniques: [
		{
			name: 'idempotency_scope_key_unique',
			properties: ['scope', 'idempotencyKey'],
		},
	],
});

export const persistenceEntities = [
	WalletRow,
	WagerTransactionRow,
	WalletLedgerEntryRow,
	InboxMessageRow,
	OutboxMessageRow,
	IdempotencyRecordRow,
];
