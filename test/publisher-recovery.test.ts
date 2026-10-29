import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { OutboxMessageRow } from '../src/platform/persistence/models.js';
import {
	suite,
	outputQueueUrl,
	child,
	seed,
	until,
	published,
	receive,
} from './support/publisher-sqs-suite.js';

const { postgres, sqs, orm } = suite;

test('stale publisher returns after another process owns the lease and cannot finalize or release it', async () => {
	await seed();
	const a = await child('before-send');
	await a.send('start');
	await a.wait('before-send');
	const b = await child('before-send');
	await b.send('start');
	await b.wait('before-send');
	const claimB = await orm.em
		.fork()
		.findOneOrFail(OutboxMessageRow, { eventVersion: 1 });
	await a.send('release');
	await a.wait('publication_confirmed');
	const afterA = await orm.em
		.fork()
		.findOneOrFail(OutboxMessageRow, { eventVersion: 1 });
	expect(afterA.claimToken).toBe(claimB.claimToken);
	expect(afterA.status).toBe('PENDING');
	expect(
		a.events.find(row => row.event === 'publication_confirmed')?.result,
	).toBe('CLAIM_LOST');
	await b.send('release');
	await published(1);
}, 60000);

test('network response lost during actual SendMessage is uncertain and another process republishes', async () => {
	await seed();
	let accepted: (() => void) | undefined;
	let release: (() => void) | undefined;
	const observed = new Promise<void>(resolve => {
		accepted = resolve;
	});
	const proxy = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: async request => {
			const target = new URL(request.url);
			target.host = new URL(sqs.env.SQS_ENDPOINT ?? '').host;
			const body = await request.text();
			const response = await fetch(target, {
				method: request.method,
				headers: request.headers,
				body,
			});
			if (
				body.includes('SendMessage') ||
				request.headers
					.get('x-amz-target')
					?.endsWith('.SendMessage') === true
			) {
				expect(response.ok).toBe(true);
				await new Promise<void>(resolve => {
					release = resolve;
					accepted?.();
				});
			}
			return response;
		},
	});
	try {
		const proxyEndpoint = `http://127.0.0.1:${String(proxy.port)}`;
		const proxyQueue = new URL(outputQueueUrl());
		proxyQueue.host = new URL(proxyEndpoint).host;
		const a = await child('normal', {
			SQS_ENDPOINT: proxyEndpoint,
			SQS_EVENTS_QUEUE_URL: proxyQueue.toString(),
			PUBLISHER_TIMEOUT_MS: '10000',
			PUBLISHER_LEASE_MS: '14000',
		});
		await a.send('start');
		await Promise.race([
			observed,
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error('SendMessage proxy timeout'));
				}, 15000);
				timer.unref();
			}),
		]);
		expect((await receive(1))[0]?.body.eventId).toBeString();
		expect(
			(
				await orm.em
					.fork()
					.findOneOrFail(OutboxMessageRow, { eventVersion: 1 })
			).status,
		).toBe('PENDING');
		await a.kill();
		release?.();
		const b = await child();
		await b.send('start');
		await published(1);
		await b.wait('claim_recovered');
	} finally {
		release?.();
		await proxy.stop(true);
	}
}, 60000);

test('real SQS outage persists retry/backoff and resumes with stable envelope; malformed facts do not starve others', async () => {
	await seed(2);
	const original = await orm.em.fork().find(OutboxMessageRow, {});
	const publisher = await child('before-send');
	await publisher.send('start');
	await publisher.wait('before-send');
	await sqs.control('pause');
	try {
		await publisher.send('release');
		await publisher.wait('publication_retry');
		const rows = await orm.em.fork().find(OutboxMessageRow, {});
		expect(rows.every(row => row.status === 'PENDING')).toBe(true);
		expect(
			rows.some(
				row =>
					row.lastError === 'SEND_UNCERTAIN' &&
					row.nextAttemptAt.getTime() > row.createdAt.getTime(),
			),
		).toBe(true);
	} finally {
		await sqs.control('unpause');
	}
	await published(2);
	const messages = await receive(2);
	for (const row of original)
		expect(
			messages.find(message => message.body.eventId === row.eventId)
				?.body,
		).toEqual(row.payload);
	await orm.em.fork().insert(OutboxMessageRow, {
		eventId: crypto.randomUUID(),
		aggregateId: crypto.randomUUID(),
		eventType: 'FutureEvent',
		eventVersion: 7,
		correlationId: 'invalid-fixture',
		payload: {},
		occurredAt: new Date(),
	});
	await seed();
	await published(3);
	await publisher.wait('publication_retry');
	await until(
		async () =>
			(await orm.em.fork().count(OutboxMessageRow, {
				status: 'PENDING',
				lastError: 'INVALID_EVENT',
			})) === 1,
		'permanent event retained',
	);
}, 60000);

test('PostgreSQL outage after SQS acceptance leaves publication recoverable after restart', async () => {
	await seed();
	const a = await child('after-send');
	await a.send('start');
	await a.wait('after-send');
	expect((await receive(1))[0]?.body.eventId).toBeString();
	await postgres.control('stop');
	try {
		await a.send('release');
		await a.wait('finalization_failed');
		await a.kill();
	} finally {
		await postgres.control('start');
	}
	expect(
		(
			await orm.em
				.fork()
				.findOneOrFail(OutboxMessageRow, { eventVersion: 1 })
		).status,
	).toBe('PENDING');
	const b = await child();
	await b.send('start');
	await published(1);
	await b.wait('claim_recovered');
}, 60000);
