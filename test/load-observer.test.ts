import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Observer, validateFinancial } from '../docker/load/observer.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { openWallet } from './support/financial.js';
import { createProcessWagerUseCase } from '../src/bootstrap/wagering.js';

let postgres: TestPostgres;
let orm: MikroORM;
let observer: Observer;
beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await orm.migrator.up();
	observer = new Observer(
		new SQL({
			hostname: postgres.env.POSTGRES_HOST,
			port: Number(postgres.env.POSTGRES_PORT),
			database: postgres.env.POSTGRES_DB,
			username: postgres.env.POSTGRES_USER,
			password: postgres.env.POSTGRES_PASSWORD,
			max: 1,
			connection: { default_transaction_read_only: 'on' },
		}),
	);
}, 90000);
afterAll(async () => {
	await observer.sql.close();
	await orm.close(true);
	await postgres.close();
});

test('SQL observer binds wallet lists as arrays and reconciles without mutating the database', async () => {
	const wallet = await createUnitOfWork(orm).execute(context =>
		openWallet(context, '20.00'),
	);
	const rows = await observer.reconcile([wallet.id], '20.00');
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		balance: '20.00',
		calculated: '20.00',
		version: 1,
		entries: 1,
		debits: 0,
		invalid: 0,
	});
	let denied = false;
	try {
		await observer.sql`delete from wallets where id = ${wallet.id}`;
	} catch {
		denied = true;
	}
	expect(denied).toBe(true);
	expect(await observer.reconcile([], '20.00')).toEqual([]);
	const point = await observer.point('absent-provider');
	expect(point).toMatchObject({
		confirmed: 0,
		events: 0,
		pending: 0,
		inboxProcessed: 0,
	});
	expect(await observer.publication('absent-provider')).toMatchObject({
		samples: 0,
		p50: null,
		p95: null,
		p99: null,
	});
});

test('aggregated financial checks reject mismatched versions, missing effects and invalid chains', () => {
	const row = {
		id: 'w',
		balance: '19.00',
		initial: '20.00',
		calculated: '19.00',
		version: 2,
		entries: 2,
		debits: 1,
		bets: 1,
		invalid: 0,
	};
	validateFinancial([row], 1, '20.00');
	for (const changed of [
		{ ...row, version: 1 },
		{ ...row, calculated: '20.00' },
		{ ...row, bets: 2 },
		{ ...row, invalid: 1 },
	])
		expect(() => {
			validateFinancial([changed], 1, '20.00');
		}).toThrow('CRITICAL');
});

test('real effects require published facts; a stored balance divergence fails critically', async () => {
	const wallet = await createUnitOfWork(orm).execute(context =>
		openWallet(context, '20.00'),
	);
	const result = await createProcessWagerUseCase(orm).execute({
		providerId: 'load-observer',
		externalTransactionId: crypto.randomUUID(),
		idempotencyKey: crypto.randomUUID(),
		playerId: wallet.playerId,
		walletId: wallet.id,
		roundId: 'r',
		gameId: 'g',
		kind: 'BET',
		amount: { amount: '1.00', currency: 'BRL' },
	});
	expect(result.status).toBe('PROCESSED');
	let unpublished = false;
	try {
		await observer.reconcile([wallet.id], '20.00');
	} catch (error) {
		unpublished = String(error).includes('CRITICAL');
	}
	expect(unpublished).toBe(true);
	// Technical publication marking is a fixture, not a financial repair.
	await orm.em.execute(
		"update outbox_messages set status = 'PUBLISHED', published_at = clock_timestamp() where correlation_id = ?",
		[result.transactionId],
	);
	expect((await observer.reconcile([wallet.id], '20.00'))[0]).toMatchObject({
		balance: '19.00',
		calculated: '19.00',
		version: 2,
		debits: 1,
	});
	await orm.em.execute('update wallets set balance = 18.00 where id = ?', [
		wallet.id,
	]);
	let divergence = false;
	try {
		await observer.reconcile([wallet.id], '20.00');
	} catch (error) {
		divergence = String(error).includes('balance != ledger');
	}
	expect(divergence).toBe(true);
});
