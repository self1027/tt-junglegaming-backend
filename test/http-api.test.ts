import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createApi } from '../src/bootstrap/create-api.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';

let postgres: TestPostgres;
let orm: MikroORM;
let app: INestApplication;
let url: string;
const previousEnv = { ...process.env };
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
	Object.assign(process.env, postgres.env);
	app = await createApi();
	cleanup.push(() => app.close());
	app.useLogger(false);
	await app.listen(0, '127.0.0.1');
	url = await app.getUrl();
}, 90_000);

afterAll(async () => {
	try {
		for (const close of cleanup.reverse()) await close();
	} finally {
		process.env = previousEnv;
	}
}, 30_000);

async function request(
	path: string,
	body?: unknown,
	key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${url}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(key === undefined ? {} : { 'Idempotency-Key': key }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

async function open(
	amount = '100.00',
): Promise<{ id: string; playerId: string }> {
	const playerId = crypto.randomUUID();
	const response = await request('/wallets', {
		playerId,
		initialBalance: { amount, currency: 'BRL' },
	});
	expect(response.status).toBe(201);
	if (typeof response.body.id !== 'string')
		throw new Error('Wallet id missing');
	return { id: response.body.id, playerId };
}

function wager(
	wallet: { id: string; playerId: string },
	kind = 'BET',
	amount = '25.00',
): Record<string, unknown> {
	return {
		providerId: 'provider-a',
		externalTransactionId: crypto.randomUUID(),
		walletId: wallet.id,
		playerId: wallet.playerId,
		roundId: 'round',
		gameId: 'game',
		kind,
		money: { amount, currency: 'BRL' },
	};
}

for (const amount of ['0.00', '100.00', '9007199254740993.01']) {
	test(`HTTP opening ${amount} and reconciliation expose exact persisted history`, async () => {
		const wallet = await open(amount);
		expect((await request(`/wallets/${wallet.id}`)).body).toMatchObject({
			id: wallet.id,
			balance: { amount, currency: 'BRL' },
			version: 1,
		});
		const ledger = await request(`/wallets/${wallet.id}/ledger?limit=50`);
		expect(ledger.status).toBe(200);
		expect(ledger.body.items).toHaveLength(amount === '0.00' ? 0 : 1);
		expect(
			(await request(`/wallets/${wallet.id}/reconciliation`, {})).body,
		).toMatchObject({
			consistent: true,
			calculatedBalance: { amount, currency: 'BRL' },
			difference: { amount: '0.00', currency: 'BRL' },
		});
		expect(
			(
				await orm.em.execute<{ count: string }[]>(
					"select count(*)::text from outbox_messages where payload->'data'->>'walletId' = ?",
					[wallet.id],
				)
			)[0]?.count,
		).toBe('0');
	});
}

test('HTTP replays historical balance and rejects both conflict identities without new effects', async () => {
	const wallet = await open();
	const body = wager(wallet);
	const first = await request('/wagering/transactions', body, 'key');
	expect(first.status).toBe(200);
	expect(first.body).toMatchObject({
		status: 'PROCESSED',
		balance: { amount: '75.00', currency: 'BRL' },
		idempotentReplay: false,
	});
	await request(
		'/wagering/transactions',
		wager(wallet, 'WIN', '10.00'),
		crypto.randomUUID(),
	);
	expect((await request('/wagering/transactions', body, 'key')).body).toEqual(
		{ ...first.body, idempotentReplay: true },
	);
	expect(
		(
			await request(
				'/wagering/transactions',
				{ ...body, gameId: 'changed' },
				'key',
			)
		).status,
	).toBe(409);
	expect(
		(await request('/wagering/transactions', body, 'another-key')).status,
	).toBe(409);
	expect(
		(
			await request(
				`/wagering/transactions/${String(first.body.transactionId)}`,
			)
		).body,
	).toMatchObject({
		kind: 'BET',
		status: 'PROCESSED',
		money: { amount: '25.00', currency: 'BRL' },
	});
	expect(
		(
			await request(
				`/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`,
			)
		).body,
	).toMatchObject({ transactionId: first.body.transactionId });
	expect(
		(await request(`/wallets/${wallet.id}/reconciliation`, {})).body
			.consistent,
	).toBe(true);
});

test('HTTP distinguishes structural errors, business rejection and pending acceptance', async () => {
	const wallet = await open();
	const body = wager(wallet, 'BET', '200.00');
	expect((await request('/wagering/transactions', body)).status).toBe(400);
	expect(
		await request('/wagering/transactions', body, crypto.randomUUID()),
	).toMatchObject({
		status: 422,
		body: { status: 'REJECTED', failureCode: 'BET_INSUFFICIENT_BALANCE' },
	});
	expect(
		await request(
			'/wagering/transactions',
			{
				...wager(wallet, 'REFUND'),
				referenceExternalTransactionId: 'missing',
			},
			crypto.randomUUID(),
		),
	).toMatchObject({ status: 202, body: { status: 'PENDING_REFERENCE' } });
	for (const invalid of [
		25,
		'NaN',
		'Infinity',
		'1e2',
		'-1.00',
		'1.001',
		'1',
		'',
	]) {
		expect(
			(
				await request(
					'/wagering/transactions',
					{
						...wager(wallet),
						money: { amount: invalid, currency: 'BRL' },
					},
					crypto.randomUUID(),
				)
			).status,
		).toBe(400);
	}
	for (const changes of [
		{ providerId: '\ud800' },
		{ playerId: '' },
		{ kind: 'OPENING' },
		{ unexpected: 'field' },
		{ money: { amount: '1.00', currency: 'ZZZ' } },
		{ kind: 'REFUND' },
		{ walletId: 'invalid' },
	]) {
		expect(
			(
				await request(
					'/wagering/transactions',
					{ ...wager(wallet), ...changes },
					crypto.randomUUID(),
				)
			).status,
		).toBe(400);
	}
	const malformed = await fetch(`${url}/wallets`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{broken',
	});
	expect(malformed.status).toBe(400);
	expect(await malformed.text()).not.toContain('SyntaxError');
	expect((await request(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
	expect(
		(await request(`/wallets/${crypto.randomUUID()}/reconciliation`, {}))
			.status,
	).toBe(404);
});

test('HTTP preserves reversals, zero policy, pending-reference states and provider scopes', async () => {
	const wallet = await open();
	const bet = wager(wallet, 'BET', '20.00');
	expect(
		(await request('/wagering/transactions', bet, crypto.randomUUID()))
			.status,
	).toBe(200);
	const refund: Record<string, unknown> = {
		...wager(wallet, 'REFUND', '20.00'),
		referenceExternalTransactionId: bet.externalTransactionId,
	};
	expect(
		(await request('/wagering/transactions', refund, crypto.randomUUID()))
			.status,
	).toBe(200);
	expect(
		(
			await request(
				'/wagering/transactions',
				{
					...wager(wallet, 'ROLLBACK', '20.00'),
					referenceExternalTransactionId:
						refund.externalTransactionId,
				},
				crypto.randomUUID(),
			)
		).status,
	).toBe(200);
	expect(
		await request(
			'/wagering/transactions',
			wager(wallet, 'LOSS', '0.00'),
			crypto.randomUUID(),
		),
	).toMatchObject({
		status: 200,
		body: {
			status: 'PROCESSED',
			balance: { amount: '80.00', currency: 'BRL' },
		},
	});
	expect(
		await request(
			'/wagering/transactions',
			wager(wallet, 'BET', '0.00'),
			crypto.randomUUID(),
		),
	).toMatchObject({
		status: 422,
		body: { failureCode: 'ZERO_AMOUNT_NOT_ALLOWED' },
	});
	const pending: Record<string, unknown> = {
		...wager(wallet, 'REFUND', '20.00'),
		referenceExternalTransactionId: 'absent',
	};
	await request('/wagering/transactions', pending, crypto.randomUUID());
	expect(
		await request(
			'/wagering/transactions',
			{
				...wager(wallet, 'ROLLBACK', '20.00'),
				referenceExternalTransactionId: pending.externalTransactionId,
			},
			crypto.randomUUID(),
		),
	).toMatchObject({
		status: 202,
		body: {
			status: 'PENDING',
			pendingReference: { reason: 'NOT_PROCESSED' },
		},
	});
	const rejected = wager(wallet, 'BET', '200.00');
	await request('/wagering/transactions', rejected, crypto.randomUUID());
	expect(
		await request(
			'/wagering/transactions',
			{
				...wager(wallet, 'ROLLBACK', '200.00'),
				referenceExternalTransactionId: rejected.externalTransactionId,
			},
			crypto.randomUUID(),
		),
	).toMatchObject({
		status: 422,
		body: { failureCode: 'REFERENCE_TERMINAL_INELIGIBLE' },
	});
	const shared = wager(wallet, 'WIN', '1.00');
	const key = crypto.randomUUID();
	expect((await request('/wagering/transactions', shared, key)).status).toBe(
		200,
	);
	expect(
		(
			await request(
				'/wagering/transactions',
				{ ...shared, providerId: 'provider-b' },
				key,
			)
		).status,
	).toBe(200);
	expect(
		(await request(`/wallets/${wallet.id}/reconciliation`, {})).body,
	).toMatchObject({
		consistent: true,
		calculatedBalance: { amount: '82.00', currency: 'BRL' },
		checkedEntries: 6,
	});
	const counts = await orm.em.execute<
		{
			ledgers: string;
			transactions: string;
			results: string;
			events: string;
		}[]
	>(
		`select (select count(*)::text from wallet_ledger_entries where wallet_id = ?) ledgers, (select count(*)::text from wager_transactions where wallet_id = ?) transactions, (select count(*)::text from idempotency_records i join wager_transactions w on w.id = i.transaction_id where w.wallet_id = ? and i.status = 'COMPLETED') results, (select count(*)::text from outbox_messages where payload->'data'->>'walletId' = ? and status = 'PENDING') events`,
		[wallet.id, wallet.id, wallet.id, wallet.id],
	);
	expect(counts[0]).toEqual({
		ledgers: '6',
		transactions: '12',
		results: '11',
		events: '15',
	});
});

test('HTTP validates body allowlists, header format and supplied wallet on replay', async () => {
	const wallet = await open();
	const body = wager(wallet);
	const key = crypto.randomUUID();
	for (const invalid of ['', 'x y', 'x,y'])
		expect(
			(await request('/wagering/transactions', body, invalid)).status,
		).toBe(400);
	for (const invalid of [
		null,
		[],
		true,
		{ playerId: 'p', initialBalance: { amount: 100, currency: 'BRL' } },
		{
			playerId: '\udfff',
			initialBalance: { amount: '0.00', currency: 'BRL' },
		},
		{
			playerId: 'p',
			initialBalance: {
				amount: '0.00',
				currency: 'BRL',
				unexpected: true,
			},
		},
	])
		expect((await request('/wallets', invalid)).status).toBe(400);
	expect(
		(
			await request(
				'/wagering/transactions',
				{ ...body, walletId: crypto.randomUUID() },
				key,
			)
		).status,
	).toBe(404);
	expect((await request('/wagering/transactions', body, key)).status).toBe(
		200,
	);
	expect(
		(
			await request(
				'/wagering/transactions',
				{ ...body, walletId: crypto.randomUUID() },
				key,
			)
		).status,
	).toBe(404);
	expect(
		(await request('/wagering/transactions', body, key)).body
			.idempotentReplay,
	).toBe(true);
	expect(
		(await request(`/wagering/transactions/${crypto.randomUUID()}`)).status,
	).toBe(404);
	expect(
		(await request('/providers/provider-a/wagering/transactions/missing'))
			.status,
	).toBe(404);
});
