import { expect, test } from 'bun:test';
import { ReliableConsumer } from '../src/platform/messaging/reliable-consumer.js';
import { PermanentMessageError } from '../src/platform/messaging/transport.js';
import type {
	MessageTransport,
	ReceivedMessage,
} from '../src/platform/messaging/transport.js';
import { sqsConfig } from '../src/platform/messaging/sqs-config.js';

const config = sqsConfig({
	AWS_REGION: 'us-east-1',
	SQS_QUEUE_URL: 'http://localhost/input.fifo',
	SQS_DLQ_URL: 'http://localhost/dlq.fifo',
	SQS_WAIT_SECONDS: '0',
});
function receipt(id = 'one', groupId = 'wallet'): ReceivedMessage {
	return {
		body: '{}',
		nativeId: id,
		receiptHandle: id,
		groupId,
		deduplicationId: id,
		receiveCount: 1,
	};
}
function transport(): MessageTransport & {
	acked: string[];
	changed: number[];
} {
	const acked: string[] = [];
	const changed: number[] = [];
	return {
		acked,
		changed,
		receive: (): Promise<ReceivedMessage[]> => Promise.resolve([]),
		check: (): Promise<void> => Promise.resolve(),
		close: (): void => {
			/* no resources in unit transport */
		},
		ack: (message): Promise<void> => {
			acked.push(message.nativeId);
			return Promise.resolve();
		},
		visibility: (_message, seconds): Promise<void> => {
			changed.push(seconds);
			return Promise.resolve();
		},
	};
}

test('ACK follows handler resolution for every committed business outcome and duplicate', async () => {
	for (const status of [
		'PROCESSED',
		'REJECTED',
		'PENDING_REFERENCE',
		'PENDING',
		'DUPLICATE',
	]) {
		const wire = transport();
		const order: string[] = [];
		const ack = wire.ack.bind(wire);
		wire.ack = (message): Promise<void> => {
			order.push('ack');
			return ack(message);
		};
		const consumer = new ReliableConsumer(
			wire,
			config,
			() => {
				order.push('commit');
				return Promise.resolve({ status, messageId: 'envelope-id' });
			},
			() => {
				/* quiet unit test */
			},
		);
		await consumer.consumeBatch([receipt()]);
		expect(order).toEqual(['commit', 'ack']);
		expect(wire.acked).toEqual(['one']);
	}
});

test('unconfirmed permanent/transient failures never ACK or run successors in the group', async () => {
	for (const error of [
		new Error('database down'),
		new PermanentMessageError('INVALID_WAGER_MESSAGE'),
	]) {
		const wire = transport();
		const calls: string[] = [];
		const consumer = new ReliableConsumer(
			wire,
			config,
			message => {
				calls.push(message.nativeId);
				return Promise.reject(error);
			},
			() => {
				/* quiet unit test */
			},
		);
		await consumer.consumeBatch([
			receipt(),
			receipt('two'),
			receipt('other', 'other-wallet'),
		]);
		expect(calls.sort()).toEqual(['one', 'other']);
		expect(wire.acked).toHaveLength(0);
		expect(wire.changed.length).toBeGreaterThan(0);
	}
});

test('DeleteMessage failure is diagnosed after commit and remains eligible for redelivery', async () => {
	const wire = transport();
	const events: Record<string, unknown>[] = [];
	wire.ack = (): Promise<void> => Promise.reject(new Error('lost ack'));
	const consumer = new ReliableConsumer(
		wire,
		config,
		() => Promise.resolve({ status: 'PROCESSED', messageId: 'logical' }),
		record => events.push(record),
	);
	await consumer.consumeBatch([receipt(), receipt('two')]);
	expect(events.some(event => event.event === 'ack_failed')).toBe(true);
	expect(events.some(event => event.event === 'processing_failed')).toBe(
		false,
	);
});

test('shutdown prevents new work in a received batch and aborts polling', async () => {
	const wire = transport();
	const calls: string[] = [];
	const consumer = new ReliableConsumer(
		wire,
		config,
		message => {
			calls.push(message.nativeId);
			consumer.requestStop();
			return Promise.resolve({
				status: 'PROCESSED',
				messageId: 'logical',
			});
		},
		() => {
			/* quiet unit test */
		},
	);
	await consumer.consumeBatch([receipt(), receipt('two')]);
	expect(calls).toEqual(['one']);
	expect(wire.acked).toEqual(['one']);
	expect(wire.changed).toContain(0);
	await consumer.run();
});

test('visibility renewal is bounded and failed renewal suppresses ACK', async () => {
	const wire = transport();
	const events: Record<string, unknown>[] = [];
	wire.visibility = (): Promise<void> =>
		Promise.reject(new Error('SQS unavailable'));
	const consumer = new ReliableConsumer(
		wire,
		{ ...config, visibilitySeconds: 1, processingMs: 1000 },
		async () => {
			await Bun.sleep(450);
			return { status: 'PROCESSED', messageId: 'logical' };
		},
		event => events.push(event),
	);
	await consumer.consumeBatch([receipt()]);
	expect(wire.acked).toHaveLength(0);
	expect(events.some(event => event.event === 'visibility_failed')).toBe(
		true,
	);
});

test('polling receives one message at a time so poison cannot spend successor attempts', async () => {
	const wire = transport();
	const batchSizes: number[] = [];
	const queue = [receipt('poison'), receipt('valid-1'), receipt('valid-2')];
	let received = 0;
	wire.receive = async (max): Promise<ReceivedMessage[]> => {
		batchSizes.push(max);
		received++;
		if (received > 20) {
			consumer.requestStop();
			return [];
		}
		if (queue.length === 0) await Bun.sleep(1);
		return queue.splice(0, max);
	};
	const consumer = new ReliableConsumer(
		wire,
		{ ...config, batchSize: 4, concurrency: 4 },
		message =>
			message.nativeId === 'poison'
				? Promise.reject(new PermanentMessageError('INVALID'))
				: Promise.resolve({
						status: 'PROCESSED',
						messageId: message.nativeId,
					}),
		() => {
			/* quiet unit test */
		},
	);
	await consumer.run();
	expect(batchSizes.every(size => size === 1)).toBe(true);
	expect(wire.acked.sort()).toEqual(['valid-1', 'valid-2']);
});

test('visibility extensions stop at the processing deadline and defer ACK', async () => {
	const wire = transport();
	const events: Record<string, unknown>[] = [];
	const consumer = new ReliableConsumer(
		wire,
		{ ...config, visibilitySeconds: 1, processingMs: 1000 },
		async () => {
			await Bun.sleep(1400);
			return { status: 'PROCESSED', messageId: 'logical' };
		},
		event => events.push(event),
	);
	await consumer.consumeBatch([receipt()]);
	expect(wire.changed.length).toBeLessThanOrEqual(3);
	expect(wire.acked).toHaveLength(0);
	expect(events.some(event => event.event === 'processing_deadline')).toBe(
		true,
	);
});
