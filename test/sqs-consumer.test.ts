import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createApi } from '../src/bootstrap/create-api.js';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { CreateWalletUseCase } from '../src/modules/financial/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../src/modules/financial/application/reconcile-wallet.use-case.js';
import type { WageringUnitOfWork } from '../src/modules/wagering/public/persistence.js';
import type { WagerTransactionKind } from '../src/modules/wagering/public/index.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { startSqs } from './support/sqs.js';
import type { TestSqs } from './support/sqs.js';
import { startConsumer } from './support/consumer-child.js';
import type { ConsumerChild } from './support/consumer-child.js';

let postgres: TestPostgres;
let sqs: TestSqs;
let orm: MikroORM;
let uow: WageringUnitOfWork;
let app: INestApplication;
let apiUrl: string;
const previousEnv = { ...process.env };
const cleanup: (() => Promise<void>)[] = [];
const children: ConsumerChild[] = [];
beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	sqs = await startSqs();
	cleanup.push(() => sqs.close());
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
	uow = createUnitOfWork(orm);
	Object.assign(process.env, postgres.env, sqs.env, {
		...postgres.env,
		...sqs.env,
		POSTGRES_PORT: postgres.env.POSTGRES_PORT,
		POSTGRES_PASSWORD: postgres.env.POSTGRES_PASSWORD,
	});
	app = await createApi();
	cleanup.push(() => app.close());
	app.useLogger(false);
	await app.listen(0, '127.0.0.1');
	apiUrl = await app.getUrl();
}, 120000);
afterEach(async () => {
	const results = await Promise.allSettled(
		children.splice(0).map(child => child.close()),
	);
	const failures: unknown[] = [];
	for (const result of results)
		if (result.status === 'rejected') failures.push(result.reason);
	if (failures.length > 0)
		throw new AggregateError(failures, 'Consumer cleanup failed');
}, 30000);
afterAll(async () => {
	process.env = previousEnv;
	const failures: unknown[] = [];
	for (const close of cleanup.reverse()) {
		try {
			await close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0)
		throw new AggregateError(failures, 'SQS test cleanup failed');
}, 30000);

interface Input {
	messageId: string;
	type: string;
	occurredAt: string;
	data: {
		providerId: string;
		externalTransactionId: string;
		idempotencyKey: string;
		walletId: string;
		playerId: string;
		roundId: string;
		gameId: string;
		kind: WagerTransactionKind;
		money: { amount: string; currency: string };
		referenceExternalTransactionId?: string;
	};
}
async function opened(): Promise<{ id: string; playerId: string }> {
	const playerId = crypto.randomUUID();
	const wallet = await new CreateWalletUseCase(uow).execute({
		playerId,
		initialBalance: { amount: '100.00', currency: 'BRL' },
	});
	return { id: wallet.id, playerId };
}
function input(
	wallet: { id: string; playerId: string },
	kind: WagerTransactionKind = 'BET',
	amount = '10.00',
	reference?: string,
): Input {
	const id = crypto.randomUUID();
	return {
		messageId: crypto.randomUUID(),
		type: 'WagerTransactionRequested',
		occurredAt: '2026-10-29T12:00:00.000Z',
		data: {
			providerId: 'provider',
			externalTransactionId: id,
			idempotencyKey: id,
			walletId: wallet.id,
			playerId: wallet.playerId,
			roundId: 'round',
			gameId: 'game',
			kind,
			money: { amount, currency: 'BRL' },
			...(reference === undefined
				? {}
				: { referenceExternalTransactionId: reference }),
		},
	};
}
async function send(
	message: Input,
	groupId = message.data.walletId,
): Promise<void> {
	await sqs.client.send(
		new SendMessageCommand({
			QueueUrl: sqs.queueUrl,
			MessageBody: JSON.stringify(message),
			MessageGroupId: groupId,
			MessageDeduplicationId: crypto.randomUUID(),
		}),
	);
}
async function child(mode = 'normal', concurrency = 1): Promise<ConsumerChild> {
	const instance = await startConsumer(
		{
			...sqs.env,
			...postgres.env,
			SQS_ENDPOINT: sqs.env.SQS_ENDPOINT,
			SQS_QUEUE_URL: sqs.queueUrl,
			SQS_DLQ_URL: sqs.dlqUrl,
			AWS_REGION: 'us-east-1',
			AWS_ACCESS_KEY_ID: 'test',
			AWS_SECRET_ACCESS_KEY: 'test',
			SQS_CONCURRENCY: String(concurrency),
			SQS_WAIT_SECONDS: '1',
			SQS_VISIBILITY_SECONDS: '2',
			SQS_MAX_RECEIVE_COUNT: '3',
			SQS_PROCESSING_MS: '20000',
			SQS_SHUTDOWN_MS: '5000',
		},
		mode,
	);
	children.push(instance);
	return instance;
}
async function until(
	check: () => Promise<boolean>,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 25000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out: ${description}`);
}
async function completed(message: Input): Promise<void> {
	await until(
		async () =>
			(
				await orm.em.execute(
					'select id from inbox_messages where message_id = ? and status = ?',
					[message.messageId, 'PROCESSED'],
				)
			).length === 1,
		'Inbox processed',
	);
}
async function balance(
	walletId: string,
	expected: string,
	transactions: number,
	ledger: number,
	outbox: number,
): Promise<void> {
	const result = await new ReconcileWalletUseCase(uow).execute(walletId);
	expect(result.consistent).toBe(true);
	expect(result.storedBalance.amount).toBe(expected);
	expect(result.calculatedBalance.amount).toBe(expected);
	expect(result.checkedEntries).toBe(ledger);
	const wagers = await orm.em.execute<{ id: string }[]>(
		'select id from wager_transactions where wallet_id = ? and kind <> ?',
		[walletId, 'OPENING'],
	);
	expect(wagers).toHaveLength(transactions);
	const events = await orm.em.execute<{ status: string }[]>(
		'select status from outbox_messages where correlation_id in (select id::text from wager_transactions where wallet_id = ? and kind <> ?)',
		[walletId, 'OPENING'],
	);
	expect(events).toHaveLength(outbox);
	expect(events.every(event => event.status === 'PENDING')).toBe(true);
	const records = await orm.em.execute(
		'select id from idempotency_records where transaction_id in (select id from wager_transactions where wallet_id = ? and kind <> ?) and status = ?',
		[walletId, 'OPENING', 'COMPLETED'],
	);
	expect(records).toHaveLength(transactions);
}
async function locks(pids: number[]): Promise<void> {
	await until(async () => {
		const rows = await orm.em.execute<{ application_name: string }[]>(
			"select distinct application_name from pg_stat_activity where wait_event_type = 'Lock'",
		);
		return pids.every(pid =>
			rows.some(
				row => row.application_name === `wager-consumer-${String(pid)}`,
			),
		);
	}, 'independent consumers waiting on PostgreSQL locks');
}

test('three consumers: 100/80/80 under SQL contention while another wallet progresses', async () => {
	const wallet = await opened();
	const other = await opened();
	const first = await child('before-commit');
	const a = input(wallet, 'BET', '80.00');
	await send(a);
	await first.wait('before-commit');
	expect(
		await orm.em.execute(
			'select id from inbox_messages where message_id = ?',
			[a.messageId],
		),
	).toHaveLength(0);
	const second = await child();
	const b = input(wallet, 'BET', '80.00');
	// Deliberately different group: SQL must remain correct even with producer misgrouping.
	await send(b, 'contention-group');
	await locks([second.pid]);
	const third = await child();
	const independent = input(other);
	await send(independent);
	await third.wait('acked', independent.messageId);
	await balance(other.id, '90.00', 1, 2, 2);
	await first.send('release');
	await first.wait('acked', a.messageId);
	await second.wait('acked', b.messageId);
	const statuses = await orm.em.execute<{ status: string }[]>(
		'select status from wager_transactions where wallet_id = ? and kind <> ?',
		[wallet.id, 'OPENING'],
	);
	expect(statuses.map(row => row.status).sort()).toEqual([
		'PROCESSED',
		'REJECTED',
	]);
	await balance(wallet.id, '20.00', 2, 2, 3);
	console.log(
		JSON.stringify({
			event: 'sqs-100-80-80',
			pids: [first.pid, second.pid, third.pid],
			balance: '20.00',
			debits: 1,
		}),
	);
}, 60000);

test('50 distinct SQS messages share one business identity across three real consumers', async () => {
	const wallet = await opened();
	const original = input(wallet);
	const first = await child('before-commit');
	await send(original);
	await first.wait('before-commit');
	const second = await child();
	const third = await child();
	const duplicates = Array.from({ length: 49 }, () => ({
		...original,
		messageId: crypto.randomUUID(),
	}));
	await Promise.all(
		duplicates.map(message => send(message, crypto.randomUUID())),
	);
	await locks([second.pid, third.pid]);
	await first.send('release');
	await Promise.all(
		[original, ...duplicates].map(message => completed(message)),
	);
	await until(
		() =>
			Promise.resolve(
				[first, second, third].reduce(
					(sum, instance) =>
						sum +
						instance.events.filter(event => event.event === 'acked')
							.length,
					0,
				) === 50,
			),
		'50 post-commit ACKs',
	);
	await balance(wallet.id, '90.00', 1, 2, 2);
	const inbox = await orm.em.execute(
		'select id from inbox_messages where message_id in (' +
			[original, ...duplicates].map(() => '?').join(',') +
			')',
		[original, ...duplicates].map(message => message.messageId),
	);
	expect(inbox).toHaveLength(50);
	console.log(
		JSON.stringify({
			event: 'sqs-50-duplicates',
			pids: [first.pid, second.pid, third.pid],
			inbox: 50,
			financialApplications: 1,
		}),
	);
}, 60000);

test('crash before commit rolls back all effects and another process handles redelivery', async () => {
	const wallet = await opened();
	const message = input(wallet);
	const first = await child('before-commit');
	await send(message);
	await first.wait('before-commit');
	expect(
		await orm.em.execute(
			'select id from inbox_messages where message_id = ?',
			[message.messageId],
		),
	).toHaveLength(0);
	await first.kill();
	await balance(wallet.id, '100.00', 0, 1, 0);
	const recovered = await child();
	await recovered.wait('acked', message.messageId);
	await balance(wallet.id, '90.00', 1, 2, 2);
	console.log(
		JSON.stringify({
			event: 'sqs-crash-before-commit',
			killedPid: first.pid,
			recoveryPid: recovered.pid,
			receiveCount: recovered.events.find(
				event => event.event === 'acked',
			)?.receiveCount,
		}),
	);
}, 60000);

test('crash after commit before ACK re-delivers the same message without new effects', async () => {
	const wallet = await opened();
	const message = input(wallet);
	const first = await child('after-commit');
	await send(message);
	await first.wait('committed-before-ack');
	await completed(message);
	await balance(wallet.id, '90.00', 1, 2, 2);
	await first.kill();
	const recovered = await child();
	const ack = await recovered.wait('acked', message.messageId);
	expect(ack.status).toBe('DUPLICATE');
	expect(ack.receiveCount).toBeGreaterThanOrEqual(2);
	await balance(wallet.id, '90.00', 1, 2, 2);
	console.log(
		JSON.stringify({
			event: 'sqs-crash-after-commit',
			killedPid: first.pid,
			recoveryPid: recovered.pid,
			receiveCount: ack.receiveCount,
		}),
	);
}, 60000);

test('DeleteMessage failure and expired visibility both recover through Inbox', async () => {
	const wallet = await opened();
	const message = input(wallet);
	const first = await child('ack-fail');
	await send(message);
	await first.wait('injected-ack-failure');
	await first.wait('acked', message.messageId);
	expect(
		first.events.some(
			event => event.event === 'acked' && event.status === 'DUPLICATE',
		),
	).toBe(true);
	await balance(wallet.id, '90.00', 1, 2, 2);
	await first.close();
	children.splice(children.indexOf(first), 1);
	const next = input(wallet);
	const holder = await child('expire-before-commit');
	await send(next);
	await holder.wait('before-commit');
	const waiter = await child();
	await locks([waiter.pid]);
	await holder.kill();
	await waiter.wait('acked', next.messageId);
	await balance(wallet.id, '80.00', 2, 3, 4);
}, 60000);

test('HTTP ↔ SQS preserves historical replay and business identity', async () => {
	const wallet = await opened();
	const consumer = await child();
	const message = input(wallet);
	const http = async (
		body: Input,
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const { idempotencyKey, ...data } = body.data;
		const response = await fetch(`${apiUrl}/wagering/transactions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': idempotencyKey,
			},
			body: JSON.stringify(data),
		});
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	};
	const initial = await http(message);
	expect(initial.status).toBe(200);
	await send(message);
	await consumer.wait('acked', message.messageId);
	const repetition = { ...message, messageId: crypto.randomUUID() };
	await send(repetition);
	await consumer.wait('acked', repetition.messageId);
	const other = input(wallet, 'BET', '20.00');
	await send(other);
	await consumer.wait('acked', other.messageId);
	const replay = await http(other);
	expect(replay.body.idempotentReplay).toBe(true);
	const old = await http(message);
	expect(old.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
	await balance(wallet.id, '70.00', 2, 3, 4);
}, 60000);
