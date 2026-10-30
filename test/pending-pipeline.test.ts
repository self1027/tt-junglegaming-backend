import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { publisherSqsSuite } from './support/publisher-sqs-suite.js';
import { startConsumer } from './support/consumer-child.js';
import { wagerChild } from './support/wager-child.js';
import { startHttpServer } from './support/http-server.js';
import type { ProcessWagerCommand } from '../src/modules/wagering/public/process-wager.js';
import { OutboxMessageRow } from '../src/platform/persistence/models.js';

const suite = publisherSqsSuite();

async function http(
	input: ProcessWagerCommand,
	base = suite.apiBaseUrl(),
): Promise<Response> {
	const { amount, idempotencyKey, ...data } = input;
	return fetch(`${base}/wagering/transactions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Idempotency-Key': idempotencyKey,
		},
		body: JSON.stringify({ ...data, money: amount }),
	});
}
async function sqs(input: ProcessWagerCommand): Promise<string> {
	const messageId = crypto.randomUUID();
	const { amount, ...data } = input;
	await suite.sqs.client.send(
		new SendMessageCommand({
			QueueUrl: suite.sqs.queueUrl,
			MessageGroupId: input.walletId,
			MessageDeduplicationId: messageId,
			MessageBody: JSON.stringify({
				messageId,
				type: 'WagerTransactionRequested',
				occurredAt: '2026-10-29T12:00:00.000Z',
				data: { ...data, money: amount },
			}),
		}),
	);
	return messageId;
}

test.each(['REFUND', 'ROLLBACK'] as const)(
	'%s out of order through real HTTP/SQS → worker → Outbox publisher → FIFO, with concurrent replays',
	async kind => {
		const wallet = await suite.wallet();
		const original = suite.command(
			wallet,
			kind === 'REFUND' ? 'BET' : 'WIN',
			'9007199254740993.01',
		);
		const pending = {
			...suite.command(wallet, kind, '9007199254740993.01'),
			referenceExternalTransactionId: original.externalTransactionId,
		};
		const consumer = await startConsumer(suite.env);
		suite.children.push(consumer);
		if (kind === 'REFUND') expect((await http(pending)).status).toBe(202);
		else await consumer.wait('acked', await sqs(pending));
		expect((await http(pending)).status).toBe(202);
		await consumer.wait('acked', await sqs(pending));
		expect(await suite.orm.em.fork().count(OutboxMessageRow)).toBe(1);
		expect((await http(original)).status).toBe(200);
		const worker = wagerChild(
			suite.postgres.env,
			pending,
			'hold-commit',
			'test/support/pending-process.ts',
		);
		try {
			expect(await worker.next()).toBe('ready');
			await worker.signal();
			expect(await worker.next()).toBe('before-commit');
			const replay = http(pending);
			const messageId = await sqs(pending);
			await suite.until(
				async () =>
					(
						await suite.orm.em.execute(
							"select pid from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%idempotency_records%' and application_name not like 'pending-test-%'",
						)
					).length >= 2,
				'HTTP/SQS replay blocked on resolving idempotency',
			);
			await worker.signal();
			expect(await worker.next()).toBe('PROCESSED');
			expect(await (await replay).json()).toMatchObject({
				status: 'PROCESSED',
				idempotentReplay: true,
				balance: { amount: '9007199254741093.01' },
			});
			await consumer.wait('acked', messageId);
		} finally {
			await worker.close();
		}
		await consumer.wait('acked', await sqs(pending));
		expect(await (await http(pending)).json()).toMatchObject({
			status: 'PROCESSED',
			idempotentReplay: true,
		});
		const before = await suite.orm.em.fork().find(OutboxMessageRow, {});
		expect(before).toHaveLength(5);
		const publisher = await suite.child();
		await publisher.send('start');
		await suite.published(5);
		const messages = await suite.receive(5);
		expect(messages).toHaveLength(5);
		for (const event of before)
			expect(
				messages.find(m => m.body.eventId === event.eventId),
			).toMatchObject({
				body: event.payload,
				group: wallet.id,
				dedup: event.eventId,
			});
		expect(
			await suite.orm.em.execute(
				'select id from wallet_ledger_entries where wallet_id = ?',
				[wallet.id],
			),
		).toHaveLength(3);
		expect(
			await suite.orm.em.execute(
				'select id from idempotency_records where transaction_id in (select id from wager_transactions where wallet_id = ? and kind <> ?)',
				[wallet.id, 'OPENING'],
			),
		).toHaveLength(2);
		await suite.reconcile(wallet.id);
	},
	60000,
);

test.each(['REFUND', 'ROLLBACK'] as const)(
	'HTTP %s and the other modality via SQS serialize while a third process resolves another wallet',
	async firstKind => {
		const server = await startHttpServer({
			...suite.postgres,
			env: suite.env,
		});
		let worker: ReturnType<typeof wagerChild> | undefined;
		try {
			const consumer = await startConsumer(suite.env);
			suite.children.push(consumer);
			const opening = await fetch(`${server.url}/wallets`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					playerId: crypto.randomUUID(),
					initialBalance: { amount: '100.00', currency: 'BRL' },
				}),
			});
			expect(opening.status).toBe(201);
			const wallet = (await opening.json()) as {
				id: string;
				playerId: string;
			};
			const bet = suite.command(wallet, 'BET', '80.00');
			expect((await http(bet, server.url)).status).toBe(200);
			const otherWallet = await suite.wallet();
			const otherBet = suite.command(otherWallet, 'BET', '80.00');
			const otherPending = {
				...suite.command(otherWallet, 'REFUND', '80.00'),
				referenceExternalTransactionId: otherBet.externalTransactionId,
			};
			expect((await http(otherPending, server.url)).status).toBe(202);
			expect((await http(otherBet, server.url)).status).toBe(200);
			const first = {
				...suite.command(wallet, firstKind, '80.00'),
				referenceExternalTransactionId: bet.externalTransactionId,
			};
			const second = {
				...suite.command(
					wallet,
					firstKind === 'REFUND' ? 'ROLLBACK' : 'REFUND',
					'80.00',
				),
				referenceExternalTransactionId: bet.externalTransactionId,
			};
			await server.send('commit');
			await server.wait('armed:commit');
			const firstResponse = http(first, server.url);
			await server.wait('before-commit');
			const message = await sqs(second);
			await suite.until(
				async () =>
					(
						await suite.orm.em.execute(
							"select pid from pg_stat_activity where application_name = ? and wait_event_type = 'Lock'",
							[`wager-consumer-${String(consumer.pid)}`],
						)
					).length > 0,
				'SQS other modality waits on HTTP wallet',
			);
			worker = wagerChild(
				suite.postgres.env,
				otherPending,
				'normal',
				'test/support/pending-process.ts',
			);
			expect(await worker.next()).toBe('ready');
			await worker.signal();
			expect(await worker.next()).toBe('PROCESSED');
			console.log(
				JSON.stringify({
					scenario: 're03-http-sqs-cross-kind',
					firstKind,
					pids: [server.pid, consumer.pid, worker.pid],
				}),
			);
			await server.send('release');
			expect((await firstResponse).status).toBe(200);
			await consumer.wait('acked', message);
			expect(
				await suite.orm.em.execute(
					'select status, failure_code from wager_transactions where provider_id = ? and external_transaction_id = ?',
					[second.providerId, second.externalTransactionId],
				),
			).toEqual([
				{
					status: 'REJECTED',
					failure_code: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
				},
			]);
			expect(
				await suite.orm.em.execute(
					'select balance, version from wallets where id = ?',
					[wallet.id],
				),
			).toEqual([{ balance: '100.00', version: 3 }]);
			expect(
				await suite.orm.em.execute(
					'select id from wallet_ledger_entries where wallet_id = ?',
					[wallet.id],
				),
			).toHaveLength(3);
			for (const id of [wallet.id, otherWallet.id])
				await suite.reconcile(id);
			const publisher = await suite.child();
			await publisher.send('start');
			await suite.published(10);
			expect(await suite.receive(10)).toHaveLength(10);
		} finally {
			await worker?.close();
			await server.send('release');
			await server.close();
		}
	},
	60000,
);

test.each(['http', 'sqs'] as const)(
	'RE-03 worker versus %s after neutralization uses three real processes and publishes only committed effects',
	async transport => {
		const server = await startHttpServer({
			...suite.postgres,
			env: suite.env,
		});
		let worker: ReturnType<typeof wagerChild> | undefined;
		try {
			const consumer = await startConsumer(suite.env);
			suite.children.push(consumer);
			const wallet = await suite.wallet();
			const amount = '9007199254740993.01';
			const bet = suite.command(wallet, 'BET', amount);
			const reversal = (
				reference: ProcessWagerCommand,
				kind: 'REFUND' | 'ROLLBACK',
			): ProcessWagerCommand => ({
				...suite.command(wallet, kind, amount),
				referenceExternalTransactionId: reference.externalTransactionId,
			});
			const pending = reversal(bet, 'ROLLBACK');
			expect((await http(pending, server.url)).status).toBe(202);
			expect((await http(bet, server.url)).status).toBe(200);
			const refund = reversal(bet, 'REFUND');
			await consumer.wait('acked', await sqs(refund));
			expect(
				(await http(reversal(refund, 'ROLLBACK'), server.url)).status,
			).toBe(200);
			worker = wagerChild(
				suite.postgres.env,
				pending,
				'hold-commit',
				'test/support/pending-process.ts',
			);
			expect(await worker.next()).toBe('ready');
			await worker.signal();
			expect(await worker.next()).toBe('before-commit');
			const competitor = reversal(bet, 'ROLLBACK');
			const competingHttp =
				transport === 'http' ? http(competitor, server.url) : undefined;
			const competingMessage =
				transport === 'sqs' ? await sqs(competitor) : undefined;
			await suite.until(
				async () =>
					(
						await suite.orm.em.execute(
							'select pid from pg_stat_activity where application_name = ? and wait_event_type = ?',
							[
								transport === 'http'
									? `http-test-${String(server.pid)}`
									: `wager-consumer-${String(consumer.pid)}`,
								'Lock',
							],
						)
					).length > 0,
				'competing transport waits for resolving worker wallet',
			);
			const replayMessage = await sqs(pending);
			if (transport === 'http')
				await suite.until(
					async () =>
						(
							await suite.orm.em.execute(
								"select pid from pg_stat_activity where application_name = ? and wait_event_type = 'Lock'",
								[`wager-consumer-${String(consumer.pid)}`],
							)
						).length > 0,
					'SQS replay waits for pending idempotency',
				);
			console.log(
				JSON.stringify({
					scenario: 're03-neutralized-transports',
					transport,
					pids: [server.pid, consumer.pid, worker.pid],
				}),
			);
			await worker.signal();
			expect(await worker.next()).toBe('PROCESSED');
			if (competingHttp !== undefined)
				expect((await competingHttp).status).toBe(422);
			if (competingMessage !== undefined)
				await consumer.wait('acked', competingMessage);
			await consumer.wait('acked', replayMessage);
			expect(
				await suite.orm.em.execute(
					'select status, failure_code from wager_transactions where provider_id = ? and external_transaction_id = ?',
					[competitor.providerId, competitor.externalTransactionId],
				),
			).toEqual([
				{ status: 'REJECTED', failure_code: 'DUPLICATE_REVERSAL' },
			]);
			expect(
				await (await http(pending, server.url)).json(),
			).toMatchObject({
				status: 'PROCESSED',
				idempotentReplay: true,
				balance: { amount: '9007199254741093.01' },
			});
			expect(
				await suite.orm.em.execute(
					'select id from wallet_ledger_entries where wallet_id = ?',
					[wallet.id],
				),
			).toHaveLength(5);
			expect(
				await suite.orm.em.execute(
					'select version from wallets where id = ?',
					[wallet.id],
				),
			).toEqual([{ version: 5 }]);
			await suite.reconcile(wallet.id);
			const facts = await suite.orm.em.fork().find(OutboxMessageRow, {});
			expect(facts).toHaveLength(10);
			const publisher = await suite.child();
			await publisher.send('start');
			await suite.published(10);
			const received = await suite.receive(10);
			for (const fact of facts)
				expect(
					received.find(event => event.body.eventId === fact.eventId)
						?.body,
				).toEqual(fact.payload);
		} finally {
			await worker?.close();
			await server.send('release');
			await server.close();
		}
	},
	60000,
);
