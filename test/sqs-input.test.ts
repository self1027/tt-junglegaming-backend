import { expect, test } from 'bun:test';
import { parseWagerMessage } from '../src/modules/wagering/adapters/sqs/wager-message.js';
import { sqsConfig } from '../src/platform/messaging/sqs-config.js';

export function envelope(): Record<string, unknown> {
	return {
		messageId: 'message-1',
		type: 'WagerTransactionRequested',
		occurredAt: '2026-10-29T12:00:00.000Z',
		data: {
			providerId: 'provider',
			externalTransactionId: 'external',
			idempotencyKey: 'key',
			walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
			playerId: 'player',
			roundId: 'round',
			gameId: 'game',
			kind: 'BET',
			money: { amount: '10.00', currency: 'BRL' },
		},
	};
}

test('SQS envelope maps to the shared command and a stable Inbox identity/hash', async () => {
	const parsed = await parseWagerMessage(JSON.stringify(envelope()));
	expect(parsed.delivery.consumerName).toBe('wagering-v1');
	expect(parsed.delivery.messageId).toBe('message-1');
	expect(parsed.delivery.payloadHash).toMatch(/^[a-f\d]{64}$/);
	expect(parsed.command.amount).toEqual({ amount: '10.00', currency: 'BRL' });
	expect(parsed.command.idempotencyKey).toBe('key');
	const input = envelope();
	const reordered = {
		data: input.data,
		occurredAt: input.occurredAt,
		type: input.type,
		messageId: input.messageId,
	};
	expect(
		(await parseWagerMessage(JSON.stringify(reordered))).delivery,
	).toEqual(parsed.delivery);
	const changed = { ...input, occurredAt: '2026-10-29T12:00:01.000Z' };
	expect(
		(await parseWagerMessage(JSON.stringify(changed))).delivery.payloadHash,
	).not.toBe(parsed.delivery.payloadHash);
	expect(
		(
			await parseWagerMessage(
				JSON.stringify({
					...input,
					occurredAt: '2026-10-29T09:00:00-03:00',
				}),
			)
		).delivery.messageId,
	).toBe('message-1');
});

test('SQS rejects malformed JSON/envelope, unknown fields and impossible dates', () => {
	for (const raw of [
		'{',
		'null',
		'[]',
		'{}',
		JSON.stringify({ ...envelope(), extra: true }),
		JSON.stringify({ ...envelope(), type: 'Unknown' }),
		JSON.stringify({
			...envelope(),
			occurredAt: '2026-02-30T12:00:00.000Z',
		}),
		JSON.stringify({ ...envelope(), messageId: '\ud800' }),
	])
		expect(parseWagerMessage(raw)).rejects.toThrow();
});

test('SQS rejects numeric money, invalid Unicode, OPENING and missing references', () => {
	const data = envelope().data as Record<string, unknown>;
	for (const changed of [
		{ money: { amount: 10, currency: 'BRL' } },
		{ money: { amount: '1e2', currency: 'BRL' } },
		{ money: { amount: '-1.00', currency: 'BRL' } },
		{ providerId: '\ud800' },
		{ kind: 'OPENING' },
		{ kind: 'REFUND' },
		{ walletId: 'bad' },
		{ extra: true },
	])
		expect(
			parseWagerMessage(
				JSON.stringify({
					...envelope(),
					data: { ...data, ...changed },
				}),
			),
		).rejects.toThrow();
});

test('SQS config validates limits and permits the standard production credential chain', () => {
	const env = {
		AWS_REGION: 'us-east-1',
		SQS_QUEUE_URL:
			'https://sqs.us-east-1.amazonaws.com/123/wager-transactions.fifo',
		SQS_DLQ_URL:
			'https://sqs.us-east-1.amazonaws.com/123/wager-transactions-dlq.fifo',
	};
	expect(sqsConfig(env).endpoint).toBeUndefined();
	expect(sqsConfig(env).maxReceiveCount).toBe(5);
	for (const changed of [
		{ AWS_REGION: '' },
		{ SQS_QUEUE_URL: 'bad' },
		{ SQS_BATCH_SIZE: '11' },
		{ SQS_CONCURRENCY: '0' },
		{ SQS_WAIT_SECONDS: '21' },
		{ SQS_VISIBILITY_SECONDS: '0' },
		{ SQS_SHUTDOWN_MS: '-1' },
	])
		expect(() => sqsConfig({ ...env, ...changed })).toThrow();
});
