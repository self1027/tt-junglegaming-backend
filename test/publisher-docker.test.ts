import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
	ReceiveMessageCommand,
	DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { provisionEventsQueue } from '../src/platform/messaging/provision-sqs.js';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { CreateWalletUseCase } from '../src/modules/financial/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../src/modules/financial/application/reconcile-wallet.use-case.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import { command, startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { startSqs } from './support/sqs.js';
import type { TestSqs } from './support/sqs.js';

let postgres: TestPostgres;
let sqs: TestSqs;
let orm: MikroORM;
let eventsUrl: string;
const image = 'distributed-wagering-processor:task10';
const containers: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
	await command(['docker', 'build', '-t', image, '.']);
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	sqs = await startSqs();
	cleanup.push(() => sqs.close());
	eventsUrl = await provisionEventsQueue(
		sqs.client,
		`docker-events-${crypto.randomUUID()}`,
	);
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
}, 240000);
afterAll(async () => {
	const errors: unknown[] = [];
	for (const name of containers) {
		try {
			await command(['docker', 'rm', '--force', name]);
		} catch (error) {
			errors.push(error);
		}
	}
	for (const close of cleanup.reverse()) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0)
		throw new AggregateError(errors, 'Publisher Docker cleanup');
}, 30000);
async function until(
	check: () => Promise<boolean>,
	label: string,
): Promise<void> {
	const end = Date.now() + 30000;
	while (Date.now() < end) {
		if (await check()) return;
		await Bun.sleep(40);
	}
	throw new Error(`Publisher Docker timed out: ${label}`);
}
async function start(
	role: 'api' | 'publisher',
	overrides: Record<string, string> = {},
): Promise<string> {
	const localUrl = (value: string): string => {
		const url = new URL(value);
		url.host = 'localstack:4566';
		return url.toString();
	};
	const env = {
		POSTGRES_HOST: 'postgres',
		POSTGRES_PORT: '5432',
		POSTGRES_DB: postgres.env.POSTGRES_DB ?? '',
		POSTGRES_USER: postgres.env.POSTGRES_USER ?? '',
		POSTGRES_PASSWORD: postgres.env.POSTGRES_PASSWORD ?? '',
		AWS_REGION: 'us-east-1',
		AWS_ACCESS_KEY_ID: 'test',
		AWS_SECRET_ACCESS_KEY: 'test',
		SQS_ENDPOINT: 'http://localstack:4566',
		SQS_QUEUE_URL: localUrl(sqs.queueUrl),
		SQS_DLQ_URL: localUrl(sqs.dlqUrl),
		SQS_EVENTS_QUEUE_URL: localUrl(eventsUrl),
		SQS_MAX_RECEIVE_COUNT: '3',
		PUBLISHER_POLL_MS: '50',
		PUBLISHER_BATCH_SIZE: '1',
		PUBLISHER_CONCURRENCY: '1',
		PUBLISHER_SQL_MS: '1000',
		PUBLISHER_TIMEOUT_MS: '5000',
		PUBLISHER_LEASE_MS: '8000',
		PUBLISHER_SHUTDOWN_MS: '10000',
		...overrides,
	};
	const name = `dwp-task10-${role}-${crypto.randomUUID()}`;
	containers.push(name);
	await command([
		'docker',
		'run',
		'-d',
		'--name',
		name,
		'--network',
		postgres.network,
		'--network',
		sqs.network,
		...(role === 'api' ? ['-p', '127.0.0.1::3000'] : []),
		...Object.entries(env).flatMap(([key, value]) => [
			'-e',
			`${key}=${value}`,
		]),
		image,
		'bun',
		`dist/main.${role}.js`,
	]);
	return name;
}
async function ready(name: string): Promise<void> {
	await until(
		async () =>
			(await command(['docker', 'logs', name])).includes(
				'publisher_diagnostics',
			),
		'publisher loop/dependencies',
	);
}
async function seed(): Promise<string> {
	const uow = createUnitOfWork(orm);
	const playerId = crypto.randomUUID();
	const w = await new CreateWalletUseCase(uow).execute({
		playerId,
		initialBalance: { amount: '100.00', currency: 'BRL' },
	});
	const id = crypto.randomUUID();
	await new ProcessWagerUseCase(uow).execute({
		providerId: 'provider',
		externalTransactionId: id,
		idempotencyKey: id,
		walletId: w.id,
		playerId,
		roundId: 'round',
		gameId: 'game',
		kind: 'LOSS',
		amount: { amount: '0.00', currency: 'BRL' },
	});
	expect(
		(await new ReconcileWalletUseCase(uow).execute(w.id)).consistent,
	).toBe(true);
	const rows = await orm.em.execute<{ event_id: string }[]>(
		"select event_id from outbox_messages where payload->'data'->>'walletId' = ?",
		[w.id],
	);
	const eventId = rows[0]?.event_id;
	if (eventId === undefined) throw new Error('Missing Docker event');
	return eventId;
}
async function status(eventId: string): Promise<string | undefined> {
	const rows = await orm.em.execute<{ status: string }[]>(
		'select status from outbox_messages where event_id = ?',
		[eventId],
	);
	return rows[0]?.status;
}
async function claimed(eventId: string): Promise<void> {
	await until(
		async () =>
			(
				await orm.em.execute(
					'select id from outbox_messages where event_id = ? and claim_token is not null',
					[eventId],
				)
			).length === 1,
		'persistent claim during SQS request',
	);
}
async function exitCode(name: string): Promise<number> {
	return Number(await command(['docker', 'wait', name]));
}

async function logs(name: string): Promise<string> {
	const child = Bun.spawn(['docker', 'logs', name], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error('Cannot read publisher Docker logs');
	return stdout + stderr;
}

test('Docker build starts independent API/publisher and publishes real HTTP BET to events FIFO', async () => {
	const api = await start('api');
	const port = (await command(['docker', 'port', api, '3000/tcp']))
		.split(':')
		.at(-1);
	const url = `http://127.0.0.1:${port ?? ''}`;
	await until(async () => {
		try {
			return (await fetch(`${url}/health/ready`)).status === 200;
		} catch {
			return false;
		}
	}, 'API readiness');
	const opened: unknown = await (
		await fetch(`${url}/wallets`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				playerId: crypto.randomUUID(),
				initialBalance: { amount: '100.00', currency: 'BRL' },
			}),
		})
	).json();
	const w = opened as { id: string; playerId: string };
	const id = crypto.randomUUID();
	expect(
		(
			await fetch(`${url}/wagering/transactions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Idempotency-Key': id,
				},
				body: JSON.stringify({
					providerId: 'provider',
					externalTransactionId: id,
					playerId: w.playerId,
					walletId: w.id,
					roundId: 'round',
					gameId: 'game',
					kind: 'BET',
					money: { amount: '10.00', currency: 'BRL' },
				}),
			})
		).status,
	).toBe(200);
	const publisher = await start('publisher');
	await ready(publisher);
	await until(
		async () =>
			(
				await orm.em.execute(
					"select id from outbox_messages where status = 'PUBLISHED'",
				)
			).length === 2,
		'HTTP event publication',
	);
	const received: Record<string, unknown>[] = [];
	await until(async () => {
		const batch = await sqs.client.send(
			new ReceiveMessageCommand({
				QueueUrl: eventsUrl,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: 1,
			}),
		);
		for (const message of batch.Messages ?? []) {
			received.push(
				JSON.parse(message.Body ?? '{}') as Record<string, unknown>,
			);
			await sqs.client.send(
				new DeleteMessageCommand({
					QueueUrl: eventsUrl,
					ReceiptHandle: message.ReceiptHandle,
				}),
			);
		}
		return received.length === 2;
	}, 'real events queue');
	expect(received.map(row => row.eventType).sort()).toEqual([
		'WagerTransactionProcessed',
		'WalletBalanceChanged',
	]);
	expect(
		(await new ReconcileWalletUseCase(createUnitOfWork(orm)).execute(w.id))
			.consistent,
	).toBe(true);
	await command(['docker', 'kill', '--signal=SIGTERM', publisher]);
	expect(await exitCode(publisher)).toBe(0);
	await command(['docker', 'kill', '--signal=SIGTERM', api]);
	expect(await exitCode(api)).toBe(0);
}, 60000);

test('real SIGTERM drains SendMessage after SQS network resumes, then closes SDK/pool', async () => {
	const publisher = await start('publisher');
	await ready(publisher);
	await sqs.control('pause');
	let id: string;
	try {
		id = await seed();
		await claimed(id);
		await command(['docker', 'kill', '--signal=SIGTERM', publisher]);
		await until(
			async () =>
				(await command(['docker', 'logs', publisher])).includes(
					'publisher_stopping',
				),
			'SIGTERM handler',
		);
		expect(await status(id)).toBe('PENDING');
	} finally {
		await sqs.control('unpause');
	}
	expect(await exitCode(publisher)).toBe(0);
	expect(await status(id)).toBe('PUBLISHED');
}, 60000);

test('real shutdown deadline exits 1 without false publication; a new container recovers the orphaned lease', async () => {
	const a = await start('publisher', { PUBLISHER_SHUTDOWN_MS: '500' });
	await ready(a);
	await sqs.control('pause');
	let id: string;
	try {
		id = await seed();
		await claimed(id);
		await command(['docker', 'kill', '--signal=SIGTERM', a]);
		expect(await exitCode(a)).toBe(1);
		expect(await status(id)).toBe('PENDING');
		expect(await logs(a)).toContain('publisher_shutdown_deadline');
	} finally {
		await sqs.control('unpause');
	}
	const b = await start('publisher');
	await ready(b);
	await until(
		async () => (await status(id)) === 'PUBLISHED',
		'expired lease recovery',
	);
	expect(await command(['docker', 'logs', b])).toContain('claim_recovered');
	await command(['docker', 'kill', '--signal=SIGTERM', b]);
	expect(await exitCode(b)).toBe(0);
}, 60000);
