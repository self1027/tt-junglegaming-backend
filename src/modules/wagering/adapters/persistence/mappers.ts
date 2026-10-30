import type { InferEntity } from '@mikro-orm/core';
import type { WagerTransactionRow } from '../../../../platform/persistence/models.js';
import { Money } from '../../../financial/public/index.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import type { ProcessWagerResult } from '../../public/process-wager.js';

export function wagerToDomain(
	row: InferEntity<typeof WagerTransactionRow>,
): WagerTransaction {
	if (
		row.kind === 'OPENING' ||
		typeof row.providerId !== 'string' ||
		typeof row.externalTransactionId !== 'string' ||
		typeof row.idempotencyKey !== 'string' ||
		typeof row.payloadHash !== 'string' ||
		typeof row.roundId !== 'string' ||
		typeof row.gameId !== 'string'
	) {
		throw new Error('Stored record is not an external wager');
	}
	return WagerTransaction.rehydrate({
		id: row.id,
		providerId: row.providerId,
		externalTransactionId: row.externalTransactionId,
		idempotencyKey: row.idempotencyKey,
		payloadHash: row.payloadHash,
		walletId: row.walletId,
		playerId: row.playerId,
		roundId: row.roundId,
		gameId: row.gameId,
		kind: row.kind,
		money: Money.create({ amount: row.amount, currency: row.currency }),
		referenceExternalTransactionId:
			row.referenceExternalTransactionId ?? undefined,
		referenceTransactionId: row.referenceTransactionId ?? undefined,
		status: row.status,
		failureCode: row.failureCode ?? undefined,
		createdAt: row.createdAt,
		processedAt: row.processedAt ?? undefined,
	});
}

export function wagerToRow(
	transaction: WagerTransaction,
): InferEntity<typeof WagerTransactionRow> {
	return {
		id: transaction.id,
		providerId: transaction.providerId,
		externalTransactionId: transaction.externalTransactionId,
		idempotencyKey: transaction.idempotencyKey,
		payloadHash: transaction.payloadHash,
		walletId: transaction.walletId,
		playerId: transaction.playerId,
		roundId: transaction.roundId,
		gameId: transaction.gameId,
		kind: transaction.kind,
		status: transaction.status,
		amount: transaction.money.toProps().amount,
		currency: transaction.currency,
		referenceExternalTransactionId:
			transaction.referenceExternalTransactionId ?? null,
		referenceTransactionId: transaction.referenceTransactionId ?? null,
		failureCode: transaction.failureCode ?? null,
		createdAt: transaction.createdAt,
		updatedAt: transaction.processedAt ?? transaction.createdAt,
		processedAt: transaction.processedAt ?? null,
		attempts: 0,
		lastAttemptAt: null,
		nextAttemptAt: null,
		lastError: null,
		claimToken: null,
		claimedBy: null,
		claimedUntil: null,
	};
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error('Invalid stored wager result');
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new Error('Invalid stored wager result field');
	return value;
}

export function wagerResultFromJson(value: unknown): ProcessWagerResult {
	const data = object(value);
	if (data.idempotentReplay !== false)
		throw new Error('Invalid stored replay flag');
	const identity = {
		transactionId: text(data.transactionId),
		externalTransactionId: text(data.externalTransactionId),
		walletId: text(data.walletId),
		idempotentReplay: false,
	};
	switch (data.status) {
		case 'PROCESSED': {
			const balance = object(data.balance);
			return {
				...identity,
				status: data.status,
				balance: Money.create({
					amount: text(balance.amount),
					currency: text(balance.currency),
				}).toProps(),
			};
		}
		case 'REJECTED':
		case 'FAILED':
			return {
				...identity,
				status: data.status,
				failureCode: text(data.failureCode),
			};
		case 'PENDING_REFERENCE': {
			const pending = object(data.pendingReference);
			if (pending.reason !== 'NOT_FOUND')
				throw new Error('Invalid stored pending reason');
			return {
				...identity,
				status: data.status,
				pendingReference: {
					reason: pending.reason,
					externalTransactionId: text(pending.externalTransactionId),
				},
			};
		}
		case 'PENDING': {
			const pending = object(data.pendingReference);
			if (
				pending.reason !== 'NOT_PROCESSED' ||
				(pending.status !== 'PENDING' &&
					pending.status !== 'PENDING_REFERENCE')
			)
				throw new Error('Invalid stored reference status');
			return {
				...identity,
				status: data.status,
				pendingReference: {
					reason: pending.reason,
					externalTransactionId: text(pending.externalTransactionId),
					transactionId: text(pending.transactionId),
					status: pending.status,
				},
			};
		}
		default:
			throw new Error('Unknown stored wager result status');
	}
}
