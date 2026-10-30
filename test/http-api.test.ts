import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createApi } from '../src/bootstrap/create-api.js';
import { MikroOrmUnitOfWork } from '../src/platform/persistence/mikro-orm-unit-of-work.js';
import { WalletReconciliationDiagnostics } from '../src/bootstrap/reconciliation-diagnostics.js';
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
	process.env = Object.fromEntries(
		Object.entries({ ...process.env, ...postgres.env }).filter(
			([key]) => !key.startsWith('SQS_'),
		),
	);
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

test('HTTP emits correlated processing metrics after commit without money, player or keys', async () => {
	const wallet = await open();
	const body = wager(wallet);
	const logs: string[] = [];
	const log = spyOn(console, 'log').mockImplementation((value: unknown) => {
		logs.push(String(value));
	});
	try {
		const first = await request(
			'/wagering/transactions',
			body,
			'metrics-key',
		);
		expect(first.status).toBe(200);
		await request('/wagering/transactions', body, 'metrics-key');
		await request('/wagering/transactions/', body, 'metrics-key');
		await request('/Wagering/Transactions', body, 'metrics-key');
		const records = logs
			.map(value => JSON.parse(value) as Record<string, unknown>)
			.filter(value => value.event === 'http_wager_completed');
		expect(records).toHaveLength(4);
		expect(records[0]).toMatchObject({
			transactionId: first.body.transactionId,
			correlationId: first.body.transactionId,
			walletId: wallet.id,
			providerId: 'provider-a',
		});
		expect(JSON.stringify(records[0]?.metrics)).toContain(
			'wagering_results_total',
		);
		expect(JSON.stringify(records[1]?.metrics)).toContain(
			'duplicates_total',
		);
		for (const forbidden of [
			'100.00',
			'25.00',
			wallet.playerId,
			'metrics-key',
		])
			expect(JSON.stringify(records)).not.toContain(forbidden);
	} finally {
		log.mockRestore();
	}
});

test('HTTP invalid requests do not copy rejected identities into diagnostics', async () => {
	const body = {
		providerId: 'sensitive-provider',
		walletId: 'sensitive-value-not-a-uuid',
		transactionId: 'client-chosen-unconfirmed-id',
		messageId: 'client-chosen-message',
		correlationId: 'client-chosen-correlation',
	};
	const logs: string[] = [];
	const log = spyOn(console, 'log').mockImplementation((value: unknown) => {
		logs.push(String(value));
	});
	try {
		for (const path of ['/wallets', '/wagering/transactions'])
			expect(
				(await request(path, body, 'invalid-request-key')).status,
			).toBe(400);
		const records = logs.map(
			value => JSON.parse(value) as Record<string, unknown>,
		);
		expect(
			records.filter(record => record.event === 'http_failure'),
		).toHaveLength(2);
		expect(
			records.filter(record => record.event === 'http_wager_failed'),
		).toHaveLength(1);
		for (const value of Object.values(body))
			expect(JSON.stringify(records)).not.toContain(value);
	} finally {
		log.mockRestore();
	}
});

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

async function withFault(
	table: string,
	condition: string,
	sqlState: string,
	work: () => Promise<void>,
): Promise<void> {
	await orm.em.execute(
		`create function task08_fault() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'confidential sql failure' using errcode = '${sqlState}'; end if; return new; end $$; create trigger task08_fault before insert on ${table} for each row execute function task08_fault()`,
	);
	try {
		await work();
	} finally {
		await orm.em.execute(
			`drop trigger task08_fault on ${table}; drop function task08_fault()`,
		);
	}
}

for (const table of ['wager_transactions', 'wallet_ledger_entries']) {
	test(`HTTP rolls back wallet opening after failure in ${table}`, async () => {
		const playerId = crypto.randomUUID();
		const body = {
			playerId,
			initialBalance: { amount: '100.00', currency: 'BRL' },
		};
		const condition =
			table === 'wager_transactions'
				? `new.player_id = '${playerId}'`
				: `exists(select 1 from wallets where id = new.wallet_id and player_id = '${playerId}')`;
		await withFault(table, condition, '23514', async () => {
			expect(await request('/wallets', body)).toEqual({
				status: 500,
				body: { statusCode: 500, code: 'INTERNAL_ERROR' },
			});
			expect(
				(
					await orm.em.execute<{ count: string }[]>(
						'select count(*)::text from wallets where player_id = ?',
						[playerId],
					)
				)[0]?.count,
			).toBe('0');
			expect(
				(
					await orm.em.execute<{ count: string }[]>(
						'select count(*)::text from wager_transactions where player_id = ?',
						[playerId],
					)
				)[0]?.count,
			).toBe('0');
		});
		expect((await request('/wallets', body)).status).toBe(201);
		expect((await request('/wallets', body)).status).toBe(409);
	});
}

test('HTTP classifies transient database errors and hides unrelated unique violations', async () => {
	for (const sqlstate of ['53300', '57014', '25P03', '25P04']) {
		await withFault('wallets', 'true', sqlstate, async () => {
			expect(
				await request('/wallets', {
					playerId: crypto.randomUUID(),
					initialBalance: { amount: '0.00', currency: 'BRL' },
				}),
			).toEqual({
				status: 503,
				body: { statusCode: 503, code: 'SERVICE_UNAVAILABLE' },
			});
			expect((await request('/health/live')).status).toBe(200);
		});
	}
	await withFault('wallets', 'true', '23505', async () => {
		expect(
			(
				await request('/wallets', {
					playerId: crypto.randomUUID(),
					initialBalance: { amount: '0.00', currency: 'BRL' },
				})
			).status,
		).toBe(500);
	});
});

test('HTTP cursor preserves tied and microsecond timestamps and rejects invalid pagination', async () => {
	const wallet = await open('0.00');
	await orm.em.execute(
		`create function task08_time() returns trigger language plpgsql as $$ begin if new.wallet_id = '${wallet.id}' then new.created_at = case when new.amount = 1.00 then '2026-10-29T00:00:00.000001Z'::timestamptz else '2026-10-29T00:00:00.000002Z'::timestamptz end; new.id = case new.amount when 1.00 then 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid when 2.00 then '00000000-0000-4000-8000-000000000001'::uuid else '00000000-0000-4000-8000-000000000002'::uuid end; end if; return new; end $$; create trigger task08_time before insert on wallet_ledger_entries for each row execute function task08_time()`,
	);
	try {
		for (const amount of ['1.00', '2.00', '3.00'])
			expect(
				(
					await request(
						'/wagering/transactions',
						wager(wallet, 'WIN', amount),
						crypto.randomUUID(),
					)
				).status,
			).toBe(200);
	} finally {
		await orm.em.execute(
			'drop trigger task08_time on wallet_ledger_entries; drop function task08_time()',
		);
	}
	const seen = new Set<string>();
	let cursor = '';
	for (let i = 0; i < 3; i++) {
		const page = await request(
			`/wallets/${wallet.id}/ledger?limit=1${cursor}`,
		);
		const items = page.body.items as { id: string }[];
		expect(items).toHaveLength(1);
		for (const item of items) seen.add(item.id);
		cursor = `&cursor=${String(page.body.nextCursor)}`;
		if (i === 2) expect(page.body.nextCursor).toBeNull();
	}
	expect(seen.size).toBe(3);
	expect([...seen]).toEqual([
		'ffffffff-ffff-4fff-8fff-ffffffffffff',
		'00000000-0000-4000-8000-000000000001',
		'00000000-0000-4000-8000-000000000002',
	]);
	for (const query of [
		'limit=0',
		'limit=101',
		'limit=1.5',
		'limit=2&limit=3',
		'cursor=garbage',
		'extra=x',
	])
		expect(
			(await request(`/wallets/${wallet.id}/ledger?${query}`)).status,
		).toBe(400);
});

test('HTTP rolls back all wagering effects when the second Outbox insert fails', async () => {
	const wallet = await open();
	const body = wager(wallet);
	const key = crypto.randomUUID();
	await withFault(
		'outbox_messages',
		`new.event_type = 'WalletBalanceChanged' and new.payload->'data'->>'walletId' = '${wallet.id}' and exists(select 1 from outbox_messages where correlation_id = new.correlation_id and event_type = 'WagerTransactionProcessed')`,
		'23514',
		async () => {
			expect(
				(await request('/wagering/transactions', body, key)).status,
			).toBe(500);
			expect((await request(`/wallets/${wallet.id}`)).body).toMatchObject(
				{ balance: { amount: '100.00', currency: 'BRL' }, version: 1 },
			);
			expect(
				(await request(`/wallets/${wallet.id}/ledger`)).body.items,
			).toHaveLength(1);
			const rows = await orm.em.execute<{ count: string }[]>(
				`select ((select count(*) from wager_transactions where provider_id = ? and external_transaction_id = ?) + (select count(*) from idempotency_records where idempotency_key = ?) + (select count(*) from outbox_messages where payload->'data'->>'walletId' = ?))::text count`,
				[body.providerId, body.externalTransactionId, key, wallet.id],
			);
			expect(rows[0]?.count).toBe('0');
		},
	);
	expect((await request('/wagering/transactions', body, key)).status).toBe(
		200,
	);
	expect(
		(await request(`/wallets/${wallet.id}/reconciliation`, {})).body
			.consistent,
	).toBe(true);
});

test('HTTP reports both signed divergences without altering the disposable database history', async () => {
	for (const [stored, difference] of [
		['105.00', '5.00'],
		['95.00', '-5.00'],
	] as const) {
		const wallet = await open();
		await orm.em.execute('update wallets set balance = ? where id = ?', [
			stored,
			wallet.id,
		]);
		expect(
			(await request(`/wallets/${wallet.id}/reconciliation`, {})).body,
		).toMatchObject({
			consistent: false,
			difference: { amount: difference, currency: 'BRL' },
		});
		expect((await request(`/wallets/${wallet.id}`)).body.balance).toEqual({
			amount: stored,
			currency: 'BRL',
		});
	}
	expect(app.get(WalletReconciliationDiagnostics).divergences).toBe(2);
});

test('HTTP fixture without SQS keeps readiness 503 while liveness stays open', async () => {
	expect(await request('/health/ready')).toEqual({
		status: 503,
		body: {
			status: 'not_ready',
			checks: { postgres: 'up', sqs: 'not_configured' },
		},
	});
	expect((await request('/health/live')).status).toBe(200);
});

test('read-only UnitOfWork uses repeatable read and PostgreSQL rejects writes', async () => {
	const uow = new MikroOrmUnitOfWork(orm.em, session => session);
	expect(
		await uow.execute(
			session =>
				session.em.execute(
					"select current_setting('transaction_isolation') isolation, current_setting('transaction_read_only') read_only",
				),
			{ readOnly: true },
		),
	).toEqual([{ isolation: 'repeatable read', read_only: 'on' }]);
	const error: unknown = await uow
		.execute(
			session =>
				session.em.execute(
					"insert into wallets (player_id, currency, balance) values ('read-only-test', 'BRL', 0.00)",
				),
			{ readOnly: true },
		)
		.catch((failure: unknown) => failure);
	expect(error).toMatchObject({ code: '25006' });
	expect(
		(
			await orm.em.execute<{ count: string }[]>(
				"select count(*)::text from wallets where player_id = 'read-only-test'",
			)
		)[0]?.count,
	).toBe('0');
});

test('HTTP reports saturated PostgreSQL pool as 503 while liveness remains available', async () => {
	const originalPool = process.env.POSTGRES_POOL_MAX;
	process.env.POSTGRES_POOL_MAX = '1';
	const isolated = await createApi();
	isolated.useLogger(false);
	let release: (() => void) | undefined;
	let held: Promise<unknown> | undefined;
	try {
		await isolated.listen(0, '127.0.0.1');
		const address = await isolated.getUrl();
		let ready: (() => void) | undefined;
		const acquired = new Promise<void>(resolve => {
			ready = resolve;
		});
		held = isolated
			.get(MikroORM)
			.em.fork()
			.transactional(async () => {
				await new Promise<void>(resolve => {
					release = resolve;
					ready?.();
				});
			});
		await acquired;
		expect((await fetch(`${address}/health/live`)).status).toBe(200);
		const response = await fetch(
			`${address}/wallets/${crypto.randomUUID()}`,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			statusCode: 503,
			code: 'SERVICE_UNAVAILABLE',
		});
	} finally {
		release?.();
		await held;
		await isolated.close();
		if (originalPool === undefined) delete process.env.POSTGRES_POOL_MAX;
		else process.env.POSTGRES_POOL_MAX = originalPool;
	}
}, 15_000);
