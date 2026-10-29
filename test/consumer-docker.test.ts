import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { CreateWalletUseCase } from '../src/modules/financial/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../src/modules/financial/application/reconcile-wallet.use-case.js';
import { command, startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { startSqs } from './support/sqs.js';
import type { TestSqs } from './support/sqs.js';

let postgres: TestPostgres;
let sqs: TestSqs;
let orm: MikroORM;
const containers: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
const image = 'distributed-wagering-processor:task09';
beforeAll(async () => {
	await command(['docker', 'build', '-t', image, '.']);
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	sqs = await startSqs();
	cleanup.push(() => sqs.close());
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
}, 180000);
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
		throw new AggregateError(errors, 'Docker smoke cleanup failed');
}, 30000);

function dockerEnvironment(): string[] {
	const queueUrl = new URL(sqs.queueUrl);
	queueUrl.host = 'localstack:4566';
	const dlqUrl = new URL(sqs.dlqUrl);
	dlqUrl.host = 'localstack:4566';
	const env = {
		...postgres.env,
		POSTGRES_HOST: 'postgres',
		POSTGRES_PORT: '5432',
		AWS_REGION: 'us-east-1',
		AWS_ACCESS_KEY_ID: 'test',
		AWS_SECRET_ACCESS_KEY: 'test',
		SQS_ENDPOINT: 'http://localstack:4566',
		SQS_QUEUE_URL: queueUrl.toString(),
		SQS_DLQ_URL: dlqUrl.toString(),
		SQS_MAX_RECEIVE_COUNT: '3',
		SQS_WAIT_SECONDS: '20',
		SQS_VISIBILITY_SECONDS: '10',
		SQS_BATCH_SIZE: '1',
		SQS_CONCURRENCY: '2',
		SQS_SHUTDOWN_MS: '5000',
	};
	return Object.entries(env)
		.filter(
			([key]) =>
				key.startsWith('POSTGRES_') ||
				key.startsWith('SQS_') ||
				key.startsWith('AWS_'),
		)
		.flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}
async function until(
	check: () => Promise<boolean>,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Docker smoke timed out: ${description}`);
}
async function start(role: 'api' | 'consumer'): Promise<string> {
	const name = `dwp-task09-${role}-${crypto.randomUUID()}`;
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
		...dockerEnvironment(),
		image,
		'bun',
		role === 'api' ? 'dist/main.api.js' : 'dist/main.consumer.js',
	]);
	return name;
}

test('Docker API/consumer share SQL/SQS and real SIGTERM drains a locked transaction', async () => {
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
	expect((await fetch(`${url}/health/live`)).status).toBe(200);
	const consumer = await start('consumer');
	await until(
		async () =>
			(await command(['docker', 'logs', consumer])).includes(
				'consumer_ready',
			),
		'consumer startup',
	);
	const uow = createUnitOfWork(orm);
	const playerId = crypto.randomUUID();
	const wallet = await new CreateWalletUseCase(uow).execute({
		playerId,
		initialBalance: { amount: '100.00', currency: 'BRL' },
	});
	const messageId = crypto.randomUUID();
	const id = crypto.randomUUID();
	const blocker = orm.em.fork();
	await blocker.begin();
	try {
		await blocker.execute(
			'select id from wallets where id = ? for update',
			[wallet.id],
		);
		await sqs.client.send(
			new SendMessageCommand({
				QueueUrl: sqs.queueUrl,
				MessageGroupId: wallet.id,
				MessageDeduplicationId: id,
				MessageBody: JSON.stringify({
					messageId,
					type: 'WagerTransactionRequested',
					occurredAt: '2026-10-29T12:00:00.000Z',
					data: {
						providerId: 'provider',
						externalTransactionId: id,
						idempotencyKey: id,
						walletId: wallet.id,
						playerId,
						roundId: 'round',
						gameId: 'game',
						kind: 'BET',
						money: { amount: '10.00', currency: 'BRL' },
					},
				}),
			}),
		);
		await until(
			async () =>
				(
					await orm.em.execute(
						"select pid from pg_stat_activity where application_name like 'wager-consumer-%' and wait_event_type = 'Lock'",
					)
				).length > 0,
			'consumer SQL lock wait',
		);
		await command(['docker', 'kill', '--signal=SIGTERM', consumer]);
		await until(
			async () =>
				(await command(['docker', 'logs', consumer])).includes(
					'consumer_stopping',
				),
			'SIGTERM handler',
		);
		expect(
			await orm.em.execute(
				'select id from inbox_messages where message_id = ?',
				[messageId],
			),
		).toHaveLength(0);
		await blocker.commit();
	} finally {
		if (blocker.isInTransaction()) await blocker.rollback();
	}
	expect(await command(['docker', 'wait', consumer])).toBe('0');
	const logs = await command(['docker', 'logs', consumer]);
	expect(logs).toContain('"event":"acked"');
	expect(logs).toContain(messageId);
	const reconciliation = await new ReconcileWalletUseCase(uow).execute(
		wallet.id,
	);
	expect(reconciliation.consistent).toBe(true);
	expect(reconciliation.storedBalance.amount).toBe('90.00');
	expect(
		await orm.em.execute(
			'select id from inbox_messages where message_id = ? and status = ?',
			[messageId, 'PROCESSED'],
		),
	).toHaveLength(1);
	await command(['docker', 'kill', '--signal=SIGTERM', api]);
	expect(await command(['docker', 'wait', api])).toBe('0');
	console.log(
		JSON.stringify({
			event: 'docker-task09-smoke',
			image,
			apiReady: 200,
			consumerExit: 0,
			sigtermDuringSqlWait: true,
			balance: '90.00',
		}),
	);
}, 60000);

test('real shutdown deadline exits without ACK and another container recovers', async () => {
	const uow = createUnitOfWork(orm);
	const playerId = crypto.randomUUID();
	const wallet = await new CreateWalletUseCase(uow).execute({
		playerId,
		initialBalance: { amount: '100.00', currency: 'BRL' },
	});
	const consumer = await start('consumer');
	await until(
		async () =>
			(await command(['docker', 'logs', consumer])).includes(
				'consumer_ready',
			),
		'deadline consumer startup',
	);
	const messageId = crypto.randomUUID();
	const id = crypto.randomUUID();
	const blocker = orm.em.fork();
	await blocker.begin();
	try {
		await blocker.execute(
			'select id from wallets where id = ? for update',
			[wallet.id],
		);
		await sqs.client.send(
			new SendMessageCommand({
				QueueUrl: sqs.queueUrl,
				MessageGroupId: wallet.id,
				MessageDeduplicationId: id,
				MessageBody: JSON.stringify({
					messageId,
					type: 'WagerTransactionRequested',
					occurredAt: '2026-10-29T12:00:00.000Z',
					data: {
						providerId: 'provider',
						externalTransactionId: id,
						idempotencyKey: id,
						walletId: wallet.id,
						playerId,
						roundId: 'round',
						gameId: 'game',
						kind: 'BET',
						money: { amount: '10.00', currency: 'BRL' },
					},
				}),
			}),
		);
		await until(
			async () =>
				(
					await orm.em.execute(
						"select pid from pg_stat_activity where application_name like 'wager-consumer-%' and wait_event_type = 'Lock'",
					)
				).length > 0,
			'deadline consumer SQL lock wait',
		);
		await command(['docker', 'kill', '--signal=SIGTERM', consumer]);
		expect(await command(['docker', 'wait', consumer])).toBe('1');
		const logs = await command(['docker', 'logs', consumer]);
		expect(logs).toContain('consumer_stopping');
		expect(logs).not.toContain('"event":"acked"');
		expect(
			await orm.em.execute(
				'select id from inbox_messages where message_id = ?',
				[messageId],
			),
		).toHaveLength(0);
		expect(
			await orm.em.execute(
				'select id from idempotency_records where idempotency_key = ?',
				[id],
			),
		).toHaveLength(0);
	} finally {
		if (blocker.isInTransaction()) await blocker.rollback();
	}
	const recovery = await start('consumer');
	await until(
		async () =>
			(
				await orm.em.execute(
					'select id from inbox_messages where message_id = ? and status = ?',
					[messageId, 'PROCESSED'],
				)
			).length === 1,
		'deadline redelivery',
	);
	await until(
		async () =>
			(await command(['docker', 'logs', recovery])).includes(
				'"event":"acked"',
			),
		'recovery ACK',
	);
	const result = await new ReconcileWalletUseCase(uow).execute(wallet.id);
	expect(result.consistent).toBe(true);
	expect(result.storedBalance.amount).toBe('90.00');
	await command(['docker', 'kill', '--signal=SIGTERM', recovery]);
	expect(await command(['docker', 'wait', recovery])).toBe('0');
	console.log(
		JSON.stringify({
			event: 'docker-task09-deadline',
			originalExit: 1,
			recoveryExit: 0,
			inboxRolledBack: true,
			balance: '90.00',
		}),
	);
}, 60000);
