import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { publisherSqsSuite } from './support/publisher-sqs-suite.js';
import { startConsumer } from './support/consumer-child.js';
import { wagerChild } from './support/wager-child.js';
import type { ProcessWagerCommand } from '../src/modules/wagering/public/process-wager.js';
import { OutboxMessageRow } from '../src/platform/persistence/models.js';

const suite = publisherSqsSuite();

async function http(input: ProcessWagerCommand): Promise<Response> {
	const { amount, idempotencyKey, ...data } = input;
	return fetch(`${suite.apiBaseUrl()}/wagering/transactions`, {
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
		const consumer = await startConsumer({
			...suite.sqs.env,
			...suite.postgres.env,
		});
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
