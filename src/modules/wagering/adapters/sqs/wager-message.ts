import { Money } from '../../../financial/public/index.js';
import { WagerTransaction } from '../../public/index.js';
import type {
	WagerTransactionKind,
	ProcessWagerCommand,
} from '../../public/index.js';
import type { InboxDelivery } from '../../public/inbox.js';

export class InvalidWagerMessage extends Error {
	constructor() {
		super('INVALID_WAGER_MESSAGE');
		this.name = 'InvalidWagerMessage';
	}
}

function object(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new InvalidWagerMessage();
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.trim() === '' ||
		value.includes('\0') ||
		/[\uD800-\uDFFF]/u.test(value)
	)
		throw new InvalidWagerMessage();
	return value;
}

export async function parseWagerMessage(
	body: string,
): Promise<{ command: ProcessWagerCommand; delivery: InboxDelivery }> {
	try {
		const raw: unknown = JSON.parse(body);
		const envelope = object(raw, [
			'messageId',
			'type',
			'occurredAt',
			'data',
		]);
		const messageId = text(envelope.messageId);
		const occurredAt = text(envelope.occurredAt);
		const timestamp =
			/^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
				occurredAt,
			);
		if (
			envelope.type !== 'WagerTransactionRequested' ||
			timestamp === null ||
			!Number.isFinite(Date.parse(occurredAt)) ||
			new Date(`${timestamp[1] ?? ''}T00:00:00.000Z`)
				.toISOString()
				.slice(0, 10) !== timestamp[1]
		)
			throw new InvalidWagerMessage();
		const data = object(envelope.data, [
			'providerId',
			'externalTransactionId',
			'idempotencyKey',
			'walletId',
			'playerId',
			'roundId',
			'gameId',
			'kind',
			'money',
			'referenceExternalTransactionId',
		]);
		const money = object(data.money, ['amount', 'currency']);
		const amount = Money.create({
			amount: text(money.amount),
			currency: text(money.currency),
		});
		const walletId = text(data.walletId);
		if (
			!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
				walletId,
			)
		)
			throw new InvalidWagerMessage();
		const command: ProcessWagerCommand = {
			providerId: text(data.providerId),
			externalTransactionId: text(data.externalTransactionId),
			idempotencyKey: text(data.idempotencyKey),
			walletId: walletId.toLowerCase(),
			playerId: text(data.playerId),
			roundId: text(data.roundId),
			gameId: text(data.gameId),
			kind: text(data.kind) as WagerTransactionKind,
			amount: amount.toProps(),
			referenceExternalTransactionId:
				data.referenceExternalTransactionId == null
					? undefined
					: text(data.referenceExternalTransactionId),
		};
		WagerTransaction.validateInput({
			...command,
			money: amount,
			referenceExternalTransactionId:
				command.referenceExternalTransactionId ?? undefined,
		});
		const canonical = JSON.stringify({
			data: {
				externalTransactionId: command.externalTransactionId,
				gameId: command.gameId,
				idempotencyKey: command.idempotencyKey,
				kind: command.kind,
				money: command.amount,
				playerId: command.playerId,
				providerId: command.providerId,
				referenceExternalTransactionId:
					command.referenceExternalTransactionId ?? null,
				roundId: command.roundId,
				walletId: command.walletId,
			},
			messageId,
			occurredAt,
			type: envelope.type,
		});
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(canonical),
		);
		const payloadHash = Array.from(new Uint8Array(digest), byte =>
			byte.toString(16).padStart(2, '0'),
		).join('');
		return {
			command: Object.freeze(command),
			delivery: Object.freeze({
				consumerName: 'wagering-v1',
				messageId,
				payloadHash,
			}),
		};
	} catch {
		throw new InvalidWagerMessage();
	}
}
