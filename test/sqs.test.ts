import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	SendMessageCommand,
	ReceiveMessageCommand,
	DeleteMessageCommand,
	SetQueueAttributesCommand,
	GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { SqsTransport } from '../src/platform/messaging/sqs-transport.js';
import { sqsConfig } from '../src/platform/messaging/sqs-config.js';
import { startSqs } from './support/sqs.js';
import type { TestSqs } from './support/sqs.js';

let sqs: TestSqs;
let transport: SqsTransport;
const previousEnv = { ...process.env };
beforeAll(async () => {
	sqs = await startSqs();
	Object.assign(process.env, sqs.env);
	transport = new SqsTransport(sqsConfig(sqs.env));
}, 120000);
afterAll(async () => {
	process.env = previousEnv;
	if (typeof transport !== 'undefined') transport.close();
	if (typeof sqs !== 'undefined') await sqs.close();
}, 30000);

test('real FIFO provisioning, non-destructive readiness and receipt metadata/ACK', async () => {
	await transport.check();
	const sent = await sqs.client.send(
		new SendMessageCommand({
			QueueUrl: sqs.queueUrl,
			MessageBody: 'smoke',
			MessageGroupId: 'wallet',
			MessageDeduplicationId: crypto.randomUUID(),
		}),
	);
	if (sent.MessageId === undefined) throw new Error('Missing SQS MessageId');
	const messages = await transport.receive(1, AbortSignal.timeout(5000));
	expect(messages).toHaveLength(1);
	const message = messages[0];
	if (message === undefined) throw new Error('No receipt');
	expect(message.nativeId).toEqual(sent.MessageId);
	expect(message.groupId).toBe('wallet');
	expect(message.receiveCount).toBe(1);
	await transport.visibility(message, 2);
	await transport.ack(message);
	expect(
		(
			await sqs.client.send(
				new ReceiveMessageCommand({
					QueueUrl: sqs.queueUrl,
					WaitTimeSeconds: 0,
				}),
			)
		).Messages ?? [],
	).toHaveLength(0);
});

test('native redrive preserves poison payload and releases its FIFO group', async () => {
	const group = crypto.randomUUID();
	await sqs.client.send(
		new SendMessageCommand({
			QueueUrl: sqs.queueUrl,
			MessageBody: '{poison',
			MessageGroupId: group,
			MessageDeduplicationId: crypto.randomUUID(),
		}),
	);
	for (let i = 0; i < 3; i++) {
		const messages = await transport.receive(1, AbortSignal.timeout(5000));
		const message = messages[0];
		if (message === undefined) throw new Error('Poison receipt missing');
		expect(message.receiveCount).toBeGreaterThanOrEqual(i + 1);
		await transport.visibility(message, 0);
	}
	await transport.receive(1, AbortSignal.timeout(5000));
	const dlq = await sqs.client.send(
		new ReceiveMessageCommand({
			QueueUrl: sqs.dlqUrl,
			WaitTimeSeconds: 2,
			MessageSystemAttributeNames: ['All'],
		}),
	);
	expect(dlq.Messages?.[0]?.Body).toBe('{poison');
	await sqs.client.send(
		new DeleteMessageCommand({
			QueueUrl: sqs.dlqUrl,
			ReceiptHandle: dlq.Messages?.[0]?.ReceiptHandle,
		}),
	);
});

test('readiness refuses a DLQ policy that denies native redrive', async () => {
	await sqs.client.send(
		new SetQueueAttributesCommand({
			QueueUrl: sqs.dlqUrl,
			Attributes: {
				RedriveAllowPolicy: JSON.stringify({
					redrivePermission: 'denyAll',
				}),
			},
		}),
	);
	try {
		const error = await transport
			.check()
			.catch((error: unknown): unknown => error);
		expect(error).toBeInstanceOf(Error);
	} finally {
		await sqs.client.send(
			new SetQueueAttributesCommand({
				QueueUrl: sqs.dlqUrl,
				Attributes: {
					RedriveAllowPolicy: JSON.stringify({
						redrivePermission: 'allowAll',
					}),
				},
			}),
		);
	}
	await transport.check();
	await sqs.client.send(
		new SetQueueAttributesCommand({
			QueueUrl: sqs.dlqUrl,
			Attributes: {
				RedriveAllowPolicy: JSON.stringify({
					redrivePermission: 'byQueue',
					sourceQueueArns: [
						'arn:aws:sqs:us-east-1:000000000000:wrong.fifo',
					],
				}),
			},
		}),
	);
	try {
		const error = await transport
			.check()
			.catch((error: unknown): unknown => error);
		expect(error).toBeInstanceOf(Error);
	} finally {
		const source = await sqs.client.send(
			new GetQueueAttributesCommand({
				QueueUrl: sqs.queueUrl,
				AttributeNames: ['QueueArn'],
			}),
		);
		await sqs.client.send(
			new SetQueueAttributesCommand({
				QueueUrl: sqs.dlqUrl,
				Attributes: {
					RedriveAllowPolicy: JSON.stringify({
						redrivePermission: 'byQueue',
						sourceQueueArns: [source.Attributes?.QueueArn],
					}),
				},
			}),
		);
	}
	await transport.check();
});
