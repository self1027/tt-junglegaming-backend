import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { startHttpServer } from './support/http-server.js';
import type { HttpServer } from './support/http-server.js';

let postgres: TestPostgres;
let orm: MikroORM;
const servers: HttpServer[] = [];
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
	for (let i = 0; i < 3; i++) servers.push(await startHttpServer(postgres));
	console.log(
		JSON.stringify({
			event: 'http-servers',
			pids: servers.map(server => server.pid),
		}),
	);
}, 90_000);

afterAll(async () => {
	const serversClosed = await Promise.allSettled(
		servers.map(async server => {
			await server.send('release');
			await server.close();
			expect((await server.wait('closed')).connected).toBe(false);
		}),
	);
	const failures: unknown[] = [];
	for (const result of serversClosed)
		if (result.status === 'rejected') failures.push(result.reason);
	for (const close of cleanup.reverse()) {
		try {
			await close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0)
		throw new AggregateError(failures, 'HTTP test resource cleanup failed');
}, 30_000);

function server(index: number): HttpServer {
	const selected = servers[index];
	if (selected === undefined) throw new Error('Missing HTTP server');
	return selected;
}

async function request(
	index: number,
	path: string,
	body: unknown,
	key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${server(index).url}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(key === undefined ? {} : { 'Idempotency-Key': key }),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
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
	const result = await request(0, '/wallets', {
		playerId,
		initialBalance: { amount, currency: 'BRL' },
	});
	expect(result.status).toBe(201);
	if (typeof result.body.id !== 'string') throw new Error('Missing wallet');
	return { id: result.body.id, playerId };
}

function bet(
	wallet: { id: string; playerId: string },
	amount = '80.00',
): Record<string, unknown> {
	return {
		providerId: 'provider',
		externalTransactionId: crypto.randomUUID(),
		walletId: wallet.id,
		playerId: wallet.playerId,
		roundId: 'round',
		gameId: 'game',
		kind: 'BET',
		money: { amount, currency: 'BRL' },
	};
}

async function arm(index: number, mode: string): Promise<void> {
	await server(index).send(mode);
	await server(index).wait(`armed:${mode}`);
}

async function waitForLocks(indices: readonly number[]): Promise<void> {
	const deadline = Date.now() + 10_000;
	const names = indices.map(
		index => `http-test-${String(server(index).pid)}`,
	);
	while (Date.now() < deadline) {
		const rows = await orm.em.execute<{ application_name: string }[]>(
			`select distinct application_name from pg_stat_activity where wait_event_type = 'Lock' and application_name in (${names.map(() => '?').join(',')})`,
			names,
		);
		if (
			names.every(name => rows.some(row => row.application_name === name))
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error('Expected HTTP transactions waiting in PostgreSQL');
}

async function integrity(
	walletId: string,
	balance: string,
	version: number,
	debits: string,
	transactions: string,
	events: string,
): Promise<void> {
	const rows = await orm.em.execute<Record<string, string>[]>(
		`select balance::text, version::text, (select count(*)::text from wallet_ledger_entries where wallet_id = wallets.id and direction = 'DEBIT') debits, (select count(*)::text from wager_transactions where wallet_id = wallets.id and kind <> 'OPENING') transactions, (select count(*)::text from outbox_messages where payload->'data'->>'walletId' = wallets.id::text and status = 'PENDING') events, (select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0.00)::text from wallet_ledger_entries where wallet_id = wallets.id) calculated from wallets where id = ?`,
		[walletId],
	);
	expect(rows[0]).toEqual({
		balance,
		version: String(version),
		debits,
		transactions,
		events,
		calculated: balance,
	});
	expect(
		(await request(2, `/wallets/${walletId}/reconciliation`, {})).body
			.consistent,
	).toBe(true);
}

test('three HTTP processes preserve 100/80/80 while a different wallet commits independently', async () => {
	const wallet = await open();
	const independent = await open();
	await arm(0, 'commit');
	const first = request(
		0,
		'/wagering/transactions',
		bet(wallet),
		crypto.randomUUID(),
	);
	await server(0).wait('before-commit');
	const second = request(
		1,
		'/wagering/transactions',
		bet(wallet),
		crypto.randomUUID(),
	);
	try {
		await waitForLocks([1]);
		expect(
			(
				await request(
					2,
					'/wagering/transactions',
					bet(independent, '10.00'),
					crypto.randomUUID(),
				)
			).status,
		).toBe(200);
	} finally {
		await server(0).send('release');
	}
	expect((await first).status).toBe(200);
	expect(await second).toMatchObject({
		status: 422,
		body: { failureCode: 'BET_INSUFFICIENT_BALANCE' },
	});
	await integrity(wallet.id, '20.00', 2, '1', '2', '3');
	await integrity(independent.id, '90.00', 2, '1', '1', '2');
}, 30_000);

test('50 duplicate HTTP requests across three servers apply once and retain one Outbox set', async () => {
	const wallet = await open();
	const body = bet(wallet, '10.00');
	const key = crypto.randomUUID();
	await arm(0, 'commit');
	const first = request(0, '/wagering/transactions', body, key);
	await server(0).wait('before-commit');
	const duplicates = Array.from({ length: 49 }, (_, i) =>
		request(i % 3, '/wagering/transactions', body, key),
	);
	try {
		await waitForLocks([1, 2]);
	} finally {
		await server(0).send('release');
	}
	const results = await Promise.all([first, ...duplicates]);
	expect(results.every(result => result.status === 200)).toBe(true);
	expect(
		results.filter(result => result.body.idempotentReplay === true),
	).toHaveLength(49);
	expect(new Set(results.map(result => result.body.transactionId)).size).toBe(
		1,
	);
	await integrity(wallet.id, '90.00', 2, '1', '1', '2');
	expect(
		(
			await orm.em.execute<{ count: string }[]>(
				'select count(*)::text from idempotency_records where idempotency_key = ?',
				[key],
			)
		)[0]?.count,
	).toBe('1');
}, 30_000);

test('concurrent HTTP wallet creation has one opening and one specific conflict', async () => {
	const playerId = crypto.randomUUID();
	const body = {
		playerId,
		initialBalance: { amount: '100.00', currency: 'BRL' },
	};
	await arm(0, 'commit');
	const first = request(0, '/wallets', body);
	await server(0).wait('before-commit');
	const second = request(1, '/wallets', body);
	try {
		await waitForLocks([1]);
	} finally {
		await server(0).send('release');
	}
	const result = await first;
	expect(result.status).toBe(201);
	expect(await second).toEqual({
		status: 409,
		body: { statusCode: 409, code: 'WALLET_ALREADY_EXISTS' },
	});
	await integrity(String(result.body.id), '100.00', 1, '0', '0', '0');
	const rows = await orm.em.execute<
		{ wallets: string; openings: string; entries: string }[]
	>(
		`select (select count(*)::text from wallets where player_id = ?) wallets, (select count(*)::text from wager_transactions where player_id = ? and kind = 'OPENING') openings, (select count(*)::text from wallet_ledger_entries e join wallets w on e.wallet_id = w.id where player_id = ?) entries`,
		[playerId, playerId, playerId],
	);
	expect(rows[0]).toEqual({ wallets: '1', openings: '1', entries: '1' });
}, 30_000);

test('HTTP reconciliation retains its snapshot while another server commits between wallet and ledger reads', async () => {
	const wallet = await open();
	await arm(0, 'snapshot');
	const reconciliation = request(
		0,
		`/wallets/${wallet.id}/reconciliation`,
		{},
	);
	await server(0).wait('snapshot-read');
	try {
		expect(
			(
				await request(
					1,
					'/wagering/transactions',
					bet(wallet, '10.00'),
					crypto.randomUUID(),
				)
			).status,
		).toBe(200);
	} finally {
		await server(0).send('release');
	}
	expect((await reconciliation).body).toMatchObject({
		consistent: true,
		storedBalance: { amount: '100.00', currency: 'BRL' },
		calculatedBalance: { amount: '100.00', currency: 'BRL' },
		checkedEntries: 1,
	});
	await integrity(wallet.id, '90.00', 2, '1', '1', '2');
}, 30_000);

test('lost HTTP response after commit replays historical state on another server', async () => {
	const wallet = await open();
	const body = bet(wallet, '10.00');
	const key = crypto.randomUUID();
	await arm(0, 'response');
	const controller = new AbortController();
	const uncertain = fetch(`${server(0).url}/wagering/transactions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
		body: JSON.stringify(body),
		signal: controller.signal,
	}).catch((error: unknown) => error);
	await server(0).wait('committed-before-response');
	try {
		controller.abort();
		await uncertain;
		await integrity(wallet.id, '90.00', 2, '1', '1', '2');
		expect(
			(
				await request(
					1,
					'/wagering/transactions',
					bet(wallet, '5.00'),
					crypto.randomUUID(),
				)
			).status,
		).toBe(200);
		expect(
			await request(2, '/wagering/transactions', body, key),
		).toMatchObject({
			status: 200,
			body: {
				idempotentReplay: true,
				balance: { amount: '90.00', currency: 'BRL' },
			},
		});
	} finally {
		await server(0).send('release');
	}
	await integrity(wallet.id, '85.00', 3, '2', '2', '4');
}, 30_000);
