import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
	ReceiveMessageCommand,
	DeleteMessageCommand,
	DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { createApi } from '../../src/bootstrap/create-api.js';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../../src/modules/wagering/application/process-wager.use-case.js';
import { CreateWalletUseCase } from '../../src/modules/financial/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../src/modules/financial/application/reconcile-wallet.use-case.js';
import type { WageringUnitOfWork } from '../../src/modules/wagering/public/persistence.js';
import type {
	ProcessWagerCommand,
	WagerTransactionKind,
} from '../../src/modules/wagering/public/index.js';
import { OutboxMessageRow } from '../../src/platform/persistence/models.js';
import { provisionEventsQueue } from '../../src/platform/messaging/provision-sqs.js';
import { startPostgres, testOrm } from './postgres.js';
import type { TestPostgres } from './postgres.js';
import { startSqs } from './sqs.js';
import type { TestSqs } from './sqs.js';
import { startPublisher } from './publisher-child.js';
import type { PublisherChild } from './publisher-child.js';
import type { ConsumerChild } from './consumer-child.js';

export let postgres: TestPostgres;
export let sqs: TestSqs;
export let orm: MikroORM;
export let uow: WageringUnitOfWork;
export const suite = {
	get postgres(): TestPostgres {
		return postgres;
	},
	get sqs(): TestSqs {
		return sqs;
	},
	get orm(): MikroORM {
		return orm;
	},
};
let app: INestApplication;
let apiUrl: string;
let eventsUrl: string;
const originalEnv = { ...process.env };
const cleanup: (() => Promise<void>)[] = [];
export const children: (PublisherChild | ConsumerChild)[] = [];
beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	sqs = await startSqs();
	cleanup.push(() => sqs.close());
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
	uow = createUnitOfWork(orm);
	Object.assign(process.env, sqs.env, postgres.env, {
		...sqs.env,
		...postgres.env,
	});
	app = await createApi();
	cleanup.push(() => app.close());
	app.useLogger(false);
	await app.listen(0, '127.0.0.1');
	apiUrl = await app.getUrl();
}, 120000);
beforeEach(async () => {
	eventsUrl = await provisionEventsQueue(
		sqs.client,
		`events-${crypto.randomUUID()}`,
	);
});
afterEach(async () => {
	const results = await Promise.allSettled(
		children.splice(0).map(child => child.close()),
	);
	await sqs.client.send(new DeleteQueueCommand({ QueueUrl: eventsUrl }));
	await orm.em.execute('delete from outbox_messages');
	const errors = results
		.filter(result => result.status === 'rejected')
		.map(result => result.reason as unknown);
	if (errors.length > 0)
		throw new AggregateError(errors, 'Publisher child cleanup');
}, 30000);
afterAll(async () => {
	process.env = originalEnv;
	const errors: unknown[] = [];
	for (const close of cleanup.reverse()) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0)
		throw new AggregateError(errors, 'Publisher integration cleanup');
}, 30000);

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...sqs.env,
		...postgres.env,
		SQS_EVENTS_QUEUE_URL: eventsUrl,
		PUBLISHER_BATCH_SIZE: '1',
		PUBLISHER_CONCURRENCY: '1',
		PUBLISHER_POLL_MS: '25',
		PUBLISHER_TIMEOUT_MS: '1000',
		PUBLISHER_SQL_MS: '1000',
		PUBLISHER_LEASE_MS: '4500',
		PUBLISHER_BACKOFF_MIN_MS: '100',
		PUBLISHER_BACKOFF_MAX_MS: '1000',
		...extra,
	};
}
export async function child(
	mode = 'normal',
	extra: NodeJS.ProcessEnv = {},
): Promise<PublisherChild> {
	const instance = await startPublisher(environment(extra), mode);
	children.push(instance);
	return instance;
}
export async function until(
	check: () => Promise<boolean>,
	description: string,
	timeout = 30000,
): Promise<void> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await Bun.sleep(20);
	}
	throw new Error(`Publisher integration timed out: ${description}`);
}
export async function wallet(): Promise<{ id: string; playerId: string }> {
	const playerId = crypto.randomUUID();
	const result = await new CreateWalletUseCase(uow).execute({
		playerId,
		initialBalance: { amount: '9007199254741093.01', currency: 'BRL' },
	});
	return { id: result.id, playerId };
}
export function command(
	w: { id: string; playerId: string },
	kind: WagerTransactionKind = 'LOSS',
	amount = '0.00',
): ProcessWagerCommand {
	const id = crypto.randomUUID();
	return {
		providerId: 'provider',
		externalTransactionId: id,
		idempotencyKey: id,
		walletId: w.id,
		playerId: w.playerId,
		roundId: 'round',
		gameId: 'game',
		kind,
		amount: { amount, currency: 'BRL' },
		...(kind === 'REFUND'
			? { referenceExternalTransactionId: 'missing' }
			: {}),
	};
}
export async function seed(count = 1): Promise<void> {
	for (let i = 0; i < count; i++) {
		const w = await wallet();
		await new ProcessWagerUseCase(uow).execute(command(w));
		await reconcile(w.id);
	}
}
export async function reconcile(id: string): Promise<void> {
	expect((await new ReconcileWalletUseCase(uow).execute(id)).consistent).toBe(
		true,
	);
}
export async function published(count: number): Promise<void> {
	await until(
		async () =>
			(await orm.em
				.fork()
				.count(OutboxMessageRow, { status: 'PUBLISHED' })) === count,
		'PUBLISHED count',
	);
}
export async function receive(count: number): Promise<
	{
		body: Record<string, unknown>;
		group: string | undefined;
		dedup: string | undefined;
	}[]
> {
	const messages: {
		body: Record<string, unknown>;
		group: string | undefined;
		dedup: string | undefined;
	}[] = [];
	await until(async () => {
		const batch = await sqs.client.send(
			new ReceiveMessageCommand({
				QueueUrl: eventsUrl,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: 1,
				MessageSystemAttributeNames: [
					'MessageGroupId',
					'MessageDeduplicationId',
				],
			}),
		);
		for (const message of batch.Messages ?? []) {
			messages.push({
				body: JSON.parse(message.Body ?? '{}') as Record<
					string,
					unknown
				>,
				group: message.Attributes?.MessageGroupId,
				dedup: message.Attributes?.MessageDeduplicationId,
			});
			await sqs.client.send(
				new DeleteMessageCommand({
					QueueUrl: eventsUrl,
					ReceiptHandle: message.ReceiptHandle,
				}),
			);
		}
		return messages.length >= count;
	}, 'SQS events');
	return messages;
}

export function apiBaseUrl(): string {
	return apiUrl;
}
export function outputQueueUrl(): string {
	return eventsUrl;
}
