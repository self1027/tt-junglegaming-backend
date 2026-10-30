import assert from 'node:assert/strict';
import { SQL } from 'bun';
import {
	SQSClient,
	SendMessageCommand,
	ReceiveMessageCommand,
	DeleteMessageCommand,
	ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';

interface Money {
	amount: string;
	currency: string;
}
interface Result {
	transactionId: string;
	status: string;
	balance?: Money;
	failureCode?: string;
	idempotentReplay: boolean;
}
interface Wager {
	providerId: string;
	externalTransactionId: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: Money;
	referenceExternalTransactionId?: string;
}
interface Event {
	eventId: string;
	eventType: string;
	correlationId: string;
	aggregateId: string;
	version: number;
	data: { walletId: string; transactionId: string; [key: string]: unknown };
}
interface Outbox {
	event_id: string;
	status: string;
	payload: Event;
}
interface Entry {
	transactionId: string;
	direction: string;
	money: Money;
	balanceBefore: Money;
	balanceAfter: Money;
}

const required = (key: string): string => {
	const value = process.env[key];
	assert(value !== undefined && value !== '', `Missing ${key}`);
	return value;
};
const base = process.env.API_BASE_URL ?? 'http://api:3000';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? '45000');
assert(
	Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
	'Invalid SMOKE_TIMEOUT_MS',
);
const money = (amount: string): Money => ({ amount, currency: 'BRL' });
const pass = (text: string): void => {
	console.log(`PASS  ${text}`);
};
async function http<T>(
	path: string,
	status: number,
	body?: unknown,
	key?: string,
): Promise<T> {
	const response = await fetch(`${base}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(key === undefined ? {} : { 'Idempotency-Key': key }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(5000),
	});
	const result = (await response.json()) as T;
	assert.equal(
		response.status,
		status,
		`${path}: expected HTTP ${String(status)}, got ${String(response.status)}: ${JSON.stringify(result)}`,
	);
	return result;
}
async function until(
	description: string,
	check: () => Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(200);
	}
	throw new Error(
		`${description}: deadline exceeded (${String(timeoutMs)}ms). Inspect compose logs and /health/ready.`,
	);
}

const sql = new SQL({
	hostname: process.env.POSTGRES_HOST,
	port: Number(process.env.POSTGRES_PORT),
	database: process.env.POSTGRES_DB,
	username: process.env.POSTGRES_USER,
	password: process.env.POSTGRES_PASSWORD,
	max: 1,
	connectionTimeout: 5,
	connection: {
		default_transaction_read_only: 'on',
		statement_timeout: '5000',
	},
});
const sqs = new SQSClient({
	region: required('AWS_REGION'),
	endpoint: required('SQS_ENDPOINT'),
	maxAttempts: 1,
	requestHandler: { requestTimeout: 5000, connectionTimeout: 3000 },
});
// Unrelated events are never deleted; release their temporary visibility in finally.
const borrowedReceipts = new Set<string>();
const eventQueue = process.env.SQS_EVENTS_QUEUE_URL;
const run = crypto.randomUUID();
const providerId = `smoke-${run}`;
const playerId = `player-${run}`;
let walletId = '';
const outbox = async (): Promise<Outbox[]> => sql<Outbox[]>`
	select event_id, status, payload from outbox_messages
	where payload->'data'->>'walletId' = ${walletId} order by event_id`;
const facts = (rows: Outbox[]): Event[] => rows.map(row => row.payload);
const submit = (wager: Wager, status = 200): Promise<Result> =>
	http(
		'/wagering/transactions',
		status,
		wager,
		`${providerId}:${wager.externalTransactionId}`,
	);
const wager = (kind: string, amount: string): Wager => ({
	providerId,
	playerId,
	walletId,
	roundId: `round-${run}`,
	gameId: 'demo',
	externalTransactionId: crypto.randomUUID(),
	kind,
	money: money(amount),
});
async function reconcile(amount: string, entries: number): Promise<void> {
	const result = await http<{
		storedBalance: Money;
		calculatedBalance: Money;
		difference: Money;
		consistent: boolean;
		checkedEntries: number;
	}>(`/wallets/${walletId}/reconciliation`, 200, {});
	assert.deepEqual(result.storedBalance, money(amount), 'Stored balance');
	assert.deepEqual(result.calculatedBalance, money(amount), 'Ledger balance');
	assert.deepEqual(
		result.difference,
		money('0.00'),
		'Reconciliation difference',
	);
	assert.equal(result.consistent, true, 'Reconciliation consistency');
	assert.equal(result.checkedEntries, entries, 'Ledger entry count');
	const wallet = await http<{ balance: Money; version: number }>(
		`/wallets/${walletId}`,
		200,
	);
	assert.deepEqual(wallet.balance, money(amount));
	assert.equal(wallet.version, entries, 'Wallet version');
}
async function ledger(): Promise<Entry[]> {
	const result = await http<{ items: Entry[]; nextCursor: string | null }>(
		`/wallets/${walletId}/ledger?limit=100`,
		200,
	);
	assert.equal(result.nextCursor, null, 'Unexpected extra ledger page');
	return result.items;
}
async function main(): Promise<void> {
	await http('/health/ready', 200);
	const wallet = await http<{ id: string; balance: Money }>('/wallets', 201, {
		playerId,
		initialBalance: money('100.00'),
	});
	walletId = wallet.id;
	assert.match(walletId, /^[\da-f-]{36}$/);
	assert.deepEqual(wallet.balance, money('100.00'));
	pass(`Wallet created: ${walletId}, 100.00 BRL`);

	const bets = [wager('BET', '80.00'), wager('BET', '80.00')];
	// Both fetches start before awaiting either response; HTTP statuses are also checked.
	const responses = await Promise.all(
		bets.map(async bet => {
			const response = await fetch(`${base}/wagering/transactions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Idempotency-Key': `${providerId}:${bet.externalTransactionId}`,
				},
				body: JSON.stringify(bet),
				signal: AbortSignal.timeout(5000),
			});
			const result = (await response.json()) as Result;
			assert.equal(
				response.status,
				result.status === 'PROCESSED' ? 200 : 422,
			);
			return { bet, result };
		}),
	);
	const processed = responses.filter(
		item => item.result.status === 'PROCESSED',
	);
	const rejected = responses.filter(
		item => item.result.status === 'REJECTED',
	);
	assert.equal(processed.length, 1, 'Exactly one BET must process');
	assert.equal(rejected.length, 1, 'Exactly one BET must reject');
	const winner = processed[0];
	assert(winner !== undefined);
	assert.equal(rejected[0]?.result.failureCode, 'BET_INSUFFICIENT_BALANCE');
	assert.equal(winner.result.idempotentReplay, false);
	assert.deepEqual(winner.result.balance, money('20.00'));
	pass(
		`Concurrent bets: 100/80/80; PROCESSED ${winner.result.transactionId}, REJECTED ${rejected[0].result.transactionId}`,
	);
	await reconcile('20.00', 2);
	const entries = await ledger();
	assert.equal(
		entries.filter(entry => entry.direction === 'DEBIT').length,
		1,
	);
	assert.deepEqual(
		entries.find(entry => entry.direction === 'DEBIT'),
		{
			...entries.find(entry => entry.direction === 'DEBIT'),
			transactionId: winner.result.transactionId,
			direction: 'DEBIT',
			money: money('80.00'),
			balanceBefore: money('100.00'),
			balanceAfter: money('20.00'),
		},
	);
	pass('Ledger and reconciliation: 20.00 BRL, one debit');

	const initialFacts = facts(await outbox());
	assert.equal(
		initialFacts.length,
		3,
		'Two BET results and one balance event',
	);
	const replay = await submit(winner.bet);
	assert.deepEqual(
		replay,
		{ ...winner.result, idempotentReplay: true },
		'Replay must preserve original result',
	);
	const conflict = await http<{ code: string }>(
		'/wagering/transactions',
		409,
		{ ...winner.bet, money: money('79.00') },
		`${providerId}:${winner.bet.externalTransactionId}`,
	);
	assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
	assert.deepEqual(
		facts(await outbox()),
		initialFacts,
		'Replay/conflict must not emit events',
	);
	assert.deepEqual(
		await ledger(),
		entries,
		'Replay/conflict must not append ledger',
	);
	pass('Idempotent replay and divergent payload conflict');

	const win = wager('WIN', '5.00');
	const messageId = crypto.randomUUID();
	const message = {
		messageId,
		type: 'WagerTransactionRequested',
		occurredAt: new Date().toISOString(),
		data: {
			...win,
			idempotencyKey: `${providerId}:${win.externalTransactionId}`,
		},
	};
	const send = async (): Promise<void> => {
		await sqs.send(
			new SendMessageCommand({
				QueueUrl: process.env.SQS_QUEUE_URL,
				MessageGroupId: walletId,
				// Distinct transport IDs force delivery of the duplicate through Inbox.
				MessageDeduplicationId: crypto.randomUUID(),
				MessageBody: JSON.stringify(message),
			}),
		);
	};
	await send();
	await send();
	await until(
		'Consumer must commit both deliveries through Inbox',
		async () => {
			const rows = await sql<{ attempts: number; status: string }[]>`
			select attempts, status from inbox_messages
			where consumer_name = 'wagering-v1' and message_id = ${messageId}`;
			return (
				rows.length === 1 &&
				rows[0]?.status === 'PROCESSED' &&
				rows[0].attempts >= 2
			);
		},
	);
	const sqsResult = await http<Result>(
		`/providers/${providerId}/wagering/transactions/${win.externalTransactionId}`,
		200,
	);
	assert.equal(sqsResult.status, 'PROCESSED');
	await reconcile('25.00', 3);
	assert.equal(
		(await ledger()).filter(
			entry => entry.transactionId === sqsResult.transactionId,
		).length,
		1,
	);
	assert.equal(
		(await outbox()).length,
		5,
		'SQS duplicate must not create extra events',
	);
	// A later balance change proves the replay is a historical snapshot.
	assert.deepEqual(await submit(winner.bet), replay);
	await reconcile('25.00', 3);
	assert.equal((await outbox()).length, 5);
	pass(
		`SQS processing: ${sqsResult.transactionId}, duplicate delivered twice, balance 25.00 BRL; replay still 20.00`,
	);

	const reference = wager('BET', '3.00');
	const refund = {
		...wager('REFUND', '3.00'),
		referenceExternalTransactionId: reference.externalTransactionId,
	};
	const pending = await submit(refund, 202);
	assert.equal(pending.status, 'PENDING_REFERENCE');
	await reconcile('25.00', 3);
	const beforeResolution = await outbox();
	assert.equal(beforeResolution.length, 6);
	const pendingEvent = beforeResolution.find(
		row => row.payload.eventType === 'WagerTransactionPendingReference',
	);
	assert(pendingEvent !== undefined);
	assert.equal(
		pendingEvent.payload.data.transactionId,
		pending.transactionId,
	);
	const original = await submit(reference);
	assert.equal(original.status, 'PROCESSED');
	await until('Pending worker must resolve REFUND after BET', async () => {
		const state = await http<Result>(
			`/wagering/transactions/${pending.transactionId}`,
			200,
		);
		return state.status === 'PROCESSED';
	});
	await reconcile('25.00', 5);
	const resolved = await submit(refund);
	assert.equal(resolved.transactionId, pending.transactionId);
	assert.equal(resolved.status, 'PROCESSED');
	assert.equal(resolved.idempotentReplay, true);
	const finalLedger = await ledger();
	assert.equal(
		finalLedger.filter(
			entry =>
				entry.transactionId === pending.transactionId &&
				entry.direction === 'CREDIT',
		).length,
		1,
	);
	pass(
		`Pending reference resolution: ${pending.transactionId}, balance 25.00 BRL`,
	);

	const expected = await outbox();
	assert.equal(expected.length, 10, 'Exact number of confirmed events');
	assert.deepEqual(
		expected.find(row => row.event_id === pendingEvent.event_id)?.payload,
		pendingEvent.payload,
		'Pending event history',
	);
	assert.equal(
		expected.filter(
			row => row.payload.eventType === 'WagerTransactionProcessed',
		).length,
		4,
	);
	assert.equal(
		expected.filter(
			row => row.payload.eventType === 'WagerTransactionRejected',
		).length,
		1,
	);
	assert.equal(
		expected.filter(row => row.payload.eventType === 'WalletBalanceChanged')
			.length,
		4,
	);
	const processedWinEvent = expected.find(
		row =>
			row.payload.data.transactionId === sqsResult.transactionId &&
			row.payload.eventType === 'WagerTransactionProcessed',
	);
	assert(processedWinEvent !== undefined);
	assert.deepEqual(processedWinEvent.payload.data.money, money('5.00'));
	const winBalance = expected.find(
		row =>
			row.payload.data.transactionId === sqsResult.transactionId &&
			row.payload.eventType === 'WalletBalanceChanged',
	);
	assert(winBalance !== undefined);
	assert.deepEqual(winBalance.payload.data.balanceBefore, money('20.00'));
	assert.deepEqual(winBalance.payload.data.balanceAfter, money('25.00'));
	assert.equal(winBalance.payload.data.direction, 'CREDIT');
	assert.equal(winBalance.payload.data.walletVersion, 3);
	const observed = new Set<string>();
	await until(
		'Publisher must deliver all matching Outbox events to SQS',
		async () => {
			const batch = await sqs.send(
				new ReceiveMessageCommand({
					QueueUrl: eventQueue,
					MaxNumberOfMessages: 10,
					WaitTimeSeconds: 1,
					VisibilityTimeout: 10,
				}),
			);
			for (const item of batch.Messages ?? []) {
				assert(
					item.ReceiptHandle !== undefined && item.Body !== undefined,
					'Incomplete SQS delivery',
				);
				const event = JSON.parse(item.Body) as Event;
				if (event.data.walletId !== walletId) {
					borrowedReceipts.add(item.ReceiptHandle);
					continue;
				}
				const persisted = expected.find(
					row => row.event_id === event.eventId,
				);
				assert(
					persisted !== undefined,
					`Unexpected eventId ${event.eventId}`,
				);
				assert.deepEqual(
					event,
					persisted.payload,
					'Published envelope must equal committed Outbox payload',
				);
				assert.equal(event.version, 1);
				assert.equal(event.correlationId, event.data.transactionId);
				assert.equal(
					event.aggregateId,
					event.eventType === 'WalletBalanceChanged'
						? walletId
						: event.data.transactionId,
				);
				observed.add(event.eventId);
				await sqs.send(
					new DeleteMessageCommand({
						QueueUrl: eventQueue,
						ReceiptHandle: item.ReceiptHandle,
					}),
				);
			}
			return observed.size === expected.length;
		},
	);
	await until('Publisher must finalize Outbox rows', async () =>
		(await outbox()).every(row => row.status === 'PUBLISHED'),
	);
	assert.deepEqual(facts(await outbox()), facts(expected));
	await reconcile('25.00', 5);
	pass(
		`Transactional Outbox: ${String(observed.size)} matching eventIds received; WIN event ${processedWinEvent.event_id}`,
	);
	console.log('\nALL CHECKS PASSED');
}
try {
	await main();
} catch (error) {
	console.error(
		`FAIL  ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
} finally {
	try {
		for (const receipt of borrowedReceipts) {
			await sqs.send(
				new ChangeMessageVisibilityCommand({
					QueueUrl: eventQueue,
					ReceiptHandle: receipt,
					VisibilityTimeout: 0,
				}),
			);
		}
	} finally {
		sqs.destroy();
		await sql.close();
	}
}
