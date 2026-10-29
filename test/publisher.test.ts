import { expect, test } from 'bun:test';
import { publisherConfig } from '../src/platform/messaging/publisher-config.js';
import {
	OutboxPublisher,
	publicationFailure,
	retryDelay,
} from '../src/platform/messaging/outbox-publisher.js';
import type {
	ClaimResult,
	EventPublisher,
	OutboxClaim,
	OutboxStore,
} from '../src/platform/messaging/outbox.js';
import { InvalidOutboxEvent } from '../src/platform/messaging/outbox.js';
import {
	persistedEvent,
	stableJson,
} from '../src/modules/wagering/adapters/sqs/persisted-event.js';
import { eventRecord, exampleClaim, exampleEvents } from './support/outbox.js';

const env = {
	AWS_REGION: 'us-east-1',
	SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/events.fifo',
};
const config = publisherConfig(env);

test('all four persisted v1 envelopes serialize deterministically with exact money and wallet grouping', () => {
	const events = exampleEvents();
	for (const event of events) {
		const record = eventRecord(event);
		const original = structuredClone(record.payload);
		const message = persistedEvent(record);
		expect(JSON.parse(message.body)).toEqual(event.toJSON());
		expect(message.deduplicationId).toBe(event.eventId);
		expect(message.groupId).toBe(event.data.walletId);
		expect(message.body).toContain('9007199254740993.01');
		expect(JSON.parse(message.body)).toMatchObject({
			version: 1,
			occurredAt: '2026-10-29T12:00:00.000Z',
			causationId: 'request-1',
		});
		expect(
			persistedEvent({
				...record,
				payload: Object.fromEntries(
					Object.entries(record.payload).reverse(),
				),
			}),
		).toEqual(message);
		expect(persistedEvent(record)).toEqual(message);
		expect(record.payload).toEqual(original);
	}
});

test.each([
	{ version: 2 },
	{ eventType: 'FutureEvent' },
	{ eventId: crypto.randomUUID() },
	{ occurredAt: 'invalid' },
	{ causationId: null },
	{ extra: 'not public' },
	{ aggregateId: crypto.randomUUID() },
	{ data: null },
	{ data: { walletId: 'invalid' } },
])(
	'malformed or unsupported persisted envelope is retained as a permanent failure: %j',
	patch => {
		const claim = exampleClaim();
		expect(() =>
			persistedEvent({
				...claim,
				payload: { ...claim.payload, ...patch },
			}),
		).toThrow(InvalidOutboxEvent);
	},
);

test('metadata, money and unknown nested fields cannot be silently normalized or lost', () => {
	const claim = exampleClaim();
	const data = claim.payload.data as Record<string, unknown>;
	for (const invalid of [
		{ ...data, money: { amount: 10, currency: 'BRL' } },
		{ ...data, money: { amount: '01.00', currency: 'BRL' } },
		{ ...data, money: { amount: '1.00', currency: 'BRL', extra: true } },
		{ ...data, extra: true },
	])
		expect(() =>
			persistedEvent({
				...claim,
				payload: { ...claim.payload, data: invalid },
			}),
		).toThrow();
	expect(() => persistedEvent({ ...claim, eventVersion: 2 })).toThrow();
	expect(() => stableJson(undefined)).toThrow();
});

test('publisher configuration is independent from command/DLQ settings and bounds operation budgets', () => {
	expect(config.eventsQueueUrl).toBe(env.SQS_EVENTS_QUEUE_URL);
	expect(config.instanceId.length).toBeGreaterThan(0);
	for (const patch of [
		{ SQS_EVENTS_QUEUE_URL: 'https://host/events' },
		{ SQS_EVENTS_QUEUE_URL: 'https://user:secret@host/events.fifo' },
		{ SQS_QUEUE_URL: env.SQS_EVENTS_QUEUE_URL },
		{ SQS_DLQ_URL: env.SQS_EVENTS_QUEUE_URL },
		{ SQS_QUEUE_URL: 'http://another-host:4566/000000000000/events.fifo' },
		{ PUBLISHER_BATCH_SIZE: '5' },
		{ PUBLISHER_LEASE_MS: '20000' },
		{ PUBLISHER_TIMEOUT_MS: '0' },
		{ PUBLISHER_POLL_MS: '1e3' },
		{ PUBLISHER_INSTANCE_ID: 'has spaces' },
		{ PUBLISHER_BACKOFF_MIN_MS: '500000' },
	])
		expect(() => publisherConfig({ ...env, ...patch })).toThrow();
});

test('bounded exponential backoff with jitter does not overflow or exhaust durable events', () => {
	expect(retryDelay(1, 1000, 10000, 0.8)).toBe(1000);
	expect(retryDelay(2, 1000, 10000, 0)).toBe(1000);
	expect(retryDelay(2, 1000, 10000, 1)).toBe(2000);
	expect(retryDelay(1000000, 1000, 10000, 1)).toBe(10000);
	expect(retryDelay(3, 1000, 10000, 0.5)).toBe(2500);
});

test('error diagnostics use an allowlist and never persist exception messages', () => {
	for (const [name, code, permanent] of [
		['AccessDeniedException', 'ACCESS_DENIED', true],
		['QueueDoesNotExist', 'QUEUE_MISSING', true],
		['InvalidMessageContents', 'INVALID_REQUEST', true],
		['ThrottlingException', 'THROTTLED', false],
		['TimeoutError', 'SEND_UNCERTAIN', false],
		['secret payload', 'SEND_UNCERTAIN', false],
	] as const) {
		const error = new Error('secret credentials and financial payload');
		error.name = name;
		expect(publicationFailure(error)).toEqual({ code, permanent });
	}
	expect(publicationFailure(new InvalidOutboxEvent())).toEqual({
		code: 'INVALID_EVENT',
		permanent: true,
	});
});

function harness(): {
	store: OutboxStore;
	sender: EventPublisher;
	worker: OutboxPublisher;
	logs: Record<string, unknown>[];
	calls: string[];
} {
	const logs: Record<string, unknown>[] = [];
	const calls: string[] = [];
	const store: OutboxStore = {
		claim: () => {
			calls.push('claim');
			return Promise.resolve([]);
		},
		published: () => {
			calls.push('published');
			return Promise.resolve('UPDATED');
		},
		retry: (_claim, _delay, code) => {
			calls.push(`retry:${code}`);
			return Promise.resolve('UPDATED');
		},
		diagnostics: () =>
			Promise.resolve({ pending: 0, expired: 0, lagMs: 0 }),
	};
	const sender: EventPublisher = {
		publish: () => {
			calls.push('send');
			return Promise.resolve();
		},
		check: () => Promise.resolve(),
		close: () => {
			calls.push('close');
		},
	};
	const worker = new OutboxPublisher(store, sender, config, record => {
		logs.push(record);
	});
	return { store, sender, worker, logs, calls };
}

test('PUBLISHED follows confirmed send; SQL finalization failure retains the lease without classifying send as failed', async () => {
	const h = harness();
	await h.worker.publish(exampleClaim());
	expect(h.calls).toEqual(['send', 'published']);
	h.calls.length = 0;
	h.store.published = (): Promise<ClaimResult> => {
		h.calls.push('finalize');
		return Promise.reject(new Error('SQL unavailable'));
	};
	await h.worker.publish(exampleClaim());
	expect(h.calls).toEqual(['send', 'finalize']);
	expect(h.logs.at(-1)).toMatchObject({
		event: 'finalization_failed',
		code: 'FINALIZE_UNCERTAIN',
	});
});

test('transient/permanent failures retry without publishing and failed retry persistence stays recoverable', async () => {
	const h = harness();
	h.sender.publish = (): Promise<void> =>
		Promise.reject(new InvalidOutboxEvent());
	await h.worker.publish(exampleClaim());
	expect(h.calls).toEqual(['retry:INVALID_EVENT']);
	expect(h.logs.at(-1)).toMatchObject({
		permanent: true,
		delayMs: config.backoffMaxMs,
	});
	h.sender.publish = (): Promise<void> =>
		Promise.reject(new Error('unknown SQS result'));
	h.store.retry = (): Promise<ClaimResult> =>
		Promise.reject(new Error('SQL failed'));
	await h.worker.publish(exampleClaim());
	expect(h.logs.at(-1)).toMatchObject({ event: 'retry_persistence_failed' });
});

test('fencing refusal is diagnosed and recovered claims carry uncertain-result diagnostics', async () => {
	const h = harness();
	h.store.published = (): Promise<ClaimResult> =>
		Promise.resolve('CLAIM_LOST');
	await h.worker.publish({ ...exampleClaim(), recovered: true });
	expect(h.logs[0]).toMatchObject({
		event: 'claim_recovered',
		leaseExpired: true,
		previousResultUncertain: true,
	});
	expect(h.logs.at(-1)).toMatchObject({ result: 'CLAIM_LOST' });
});

test('shutdown stops claims and drains a publication already started', async () => {
	const h = harness();
	const claim = exampleClaim();
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const waiting = new Promise<void>(resolve => {
		started = resolve;
	});
	h.store.claim = (): Promise<readonly OutboxClaim[]> => {
		h.calls.push('claim');
		return Promise.resolve([claim]);
	};
	h.sender.publish = async (): Promise<void> => {
		await new Promise<void>(resolve => {
			release = resolve;
			started?.();
		});
	};
	const running = h.worker.run();
	await waiting;
	h.worker.requestStop();
	expect(h.calls).toEqual(['claim']);
	release?.();
	await running;
	expect(h.calls).toEqual(['claim', 'published']);
});

test('shutdown during claim does not initiate sends; cancellation of an active send cannot publish', async () => {
	const h = harness();
	h.store.claim = (): Promise<readonly OutboxClaim[]> => {
		h.worker.requestStop();
		return Promise.resolve([exampleClaim()]);
	};
	await h.worker.run();
	expect(h.calls).toEqual([]);
	h.sender.publish = (_event, signal): Promise<void> => {
		signal.throwIfAborted();
		return Promise.resolve();
	};
	h.worker.abortInFlight();
	await h.worker.publish(exampleClaim());
	expect(h.calls).toEqual(['retry:SEND_UNCERTAIN']);
});
