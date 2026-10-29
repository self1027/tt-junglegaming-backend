import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { ProcessWagerCommand } from '../src/modules/wagering/public/index.js';
import { MikroOrmOutboxStore } from '../src/platform/persistence/mikro-orm-outbox-store.js';
import { OutboxMessageRow } from '../src/platform/persistence/models.js';
import { persistedEvent } from '../src/modules/wagering/adapters/sqs/persisted-event.js';
import { startConsumer } from './support/consumer-child.js';
import { publisherSqsSuite } from './support/publisher-sqs-suite.js';

const suite = publisherSqsSuite();
const {
	apiBaseUrl,
	outputQueueUrl,
	child,
	wallet,
	command,
	children,
	seed,
	until,
	reconcile,
	published,
	receive,
} = suite;

test('HTTP and SQS consumer → committed Outbox → events FIFO; all four v1 facts and financial replay', async () => {
	const w = await wallet();
	const bet = command(w, 'BET', '9007199254740993.01');
	const http = async (input: ProcessWagerCommand): Promise<Response> => {
		const { amount, idempotencyKey, ...data } = input;
		return fetch(`${apiBaseUrl()}/wagering/transactions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': idempotencyKey,
			},
			body: JSON.stringify({ ...data, money: amount }),
		});
	};
	expect((await http(bet)).status).toBe(200);
	expect((await http(command(w, 'WIN', '0.01'))).status).toBe(200);
	expect((await http(command(w, 'BET', '1000.00'))).status).toBe(422);
	expect((await http(command(w, 'REFUND', '1.00'))).status).toBe(202);
	const loss = command(w);
	const messageId = crypto.randomUUID();
	const { amount, ...data } = loss;
	await suite.sqs.client.send(
		new SendMessageCommand({
			QueueUrl: suite.sqs.queueUrl,
			MessageGroupId: w.id,
			MessageDeduplicationId: messageId,
			MessageBody: JSON.stringify({
				messageId,
				type: 'WagerTransactionRequested',
				occurredAt: '2026-10-29T12:00:00.000Z',
				data: { ...data, money: amount },
			}),
		}),
	);
	const consumer = await startConsumer({
		...suite.sqs.env,
		...suite.postgres.env,
	});
	children.push(consumer);
	await until(
		async () =>
			(
				await suite.orm.em.execute(
					"select id from inbox_messages where message_id = ? and status = 'PROCESSED'",
					[messageId],
				)
			).length === 1,
		'SQS financial commit',
	);
	const before = await suite.orm.em.fork().find(OutboxMessageRow, {});
	expect(before).toHaveLength(7);
	expect(before.every(row => row.status === 'PENDING')).toBe(true);
	expect(new Set(before.map(row => row.eventType)).size).toBe(4);
	const publisher = await child();
	await publisher.send('start');
	await published(7);
	const received = await receive(7);
	for (const row of before) {
		const message = received.find(
			item => item.body.eventId === row.eventId,
		);
		expect(message?.body).toEqual(row.payload);
		expect(message?.dedup).toBe(row.eventId);
		expect(message?.group).toBe(w.id);
		expect(
			persistedEvent({ ...row, causationId: row.causationId ?? null })
				.body,
		).toBeString();
	}
	expect(JSON.stringify(received)).toContain('9007199254740993.01');
	const replay: unknown = await (await http(bet)).json();
	expect(replay).toMatchObject({
		idempotentReplay: true,
		balance: { amount: '100.00', currency: 'BRL' },
	});
	expect(await suite.orm.em.fork().count(OutboxMessageRow)).toBe(7);
	expect(
		await suite.orm.em.execute(
			"select id from idempotency_records where status = 'COMPLETED'",
		),
	).toHaveLength(5);
	expect(
		await suite.orm.em.execute(
			'select id from wallet_ledger_entries where wallet_id = ?',
			[w.id],
		),
	).toHaveLength(3);
	await reconcile(w.id);
	expect(
		(
			await suite.sqs.client.send(
				new ReceiveMessageCommand({
					QueueUrl: outputQueueUrl(),
					WaitTimeSeconds: 1,
				}),
			)
		).Messages ?? [],
	).toHaveLength(0);
}, 60000);

test('three independent publishers claim exclusive events in parallel and hold no SQL transaction during network work', async () => {
	await seed(9);
	const publishers = await Promise.all([
		child('before-send'),
		child('before-send'),
		child('before-send'),
	]);
	await Promise.all(publishers.map(instance => instance.send('start')));
	const held = await Promise.all(
		publishers.map(instance => instance.wait('before-send')),
	);
	expect(new Set(held.map(row => row.eventId)).size).toBe(3);
	const txs = await suite.orm.em.execute(
		"select pid from pg_stat_activity where application_name like 'outbox-publisher-%' and state = 'idle in transaction'",
	);
	expect(txs).toHaveLength(0);
	const observer = suite.orm.em.fork();
	await observer.begin();
	try {
		expect(
			await observer.execute(
				'select id from outbox_messages where claimed_by is not null for update nowait',
			),
		).toHaveLength(3);
	} finally {
		await observer.rollback();
	}
	expect(
		await suite.orm.em
			.fork()
			.count(OutboxMessageRow, { status: 'PUBLISHED' }),
	).toBe(0);
	console.log(
		JSON.stringify({
			scenario: 'three-publishers',
			pids: publishers.map(instance => instance.pid),
			heldEventIds: held.map(row => row.eventId),
		}),
	);
	await Promise.all(publishers.map(instance => instance.send('release')));
	await published(9);
	expect(
		new Set((await receive(9)).map(message => message.body.eventId)).size,
	).toBe(9);
}, 60000);

test.each(['before-send', 'after-send', 'finalize-fail'])(
	'crash/failure at %s recovers the same historical event through an expired lease',
	async mode => {
		await seed();
		const original = await suite.orm.em
			.fork()
			.findOneOrFail(OutboxMessageRow, { eventVersion: 1 });
		const a = await child(mode);
		await a.send('start');
		if (mode === 'finalize-fail') await a.wait('finalization_failed');
		else await a.wait(mode);
		const pending = await suite.orm.em
			.fork()
			.findOneOrFail(OutboxMessageRow, { eventVersion: 1 });
		expect(pending.status).toBe('PENDING');
		expect(pending.claimToken).toBeString();
		expect(pending.publishedAt).toBeNull();
		if (mode === 'after-send' || mode === 'finalize-fail')
			expect((await receive(1))[0]?.body).toEqual(original.payload);
		await a.kill();
		const b = await child();
		await b.send('start');
		await published(1);
		const final = await suite.orm.em
			.fork()
			.findOneOrFail(OutboxMessageRow, { eventVersion: 1 });
		expect(final.eventId).toBe(original.eventId);
		expect(final.payload).toEqual(original.payload);
		expect(final.occurredAt).toEqual(original.occurredAt);
		expect(final.attempts).toBe(2);
		expect(final.claimToken).toBeNull();
		await b.wait('claim_recovered', original.eventId);
		if (mode === 'before-send')
			expect((await receive(1))[0]?.body).toEqual(original.payload);
		const store = new MikroOrmOutboxStore(suite.orm.em);
		expect(await store.claim(10, 'after-published', 30000)).toHaveLength(0);
		console.log(
			JSON.stringify({
				scenario: mode,
				killed: a.pid,
				recovered: b.pid,
				eventId: original.eventId,
				attempts: final.attempts,
			}),
		);
	},
	60000,
);
