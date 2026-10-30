import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { command, startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { seedPending, pendingUntil, reconciled } from './support/pending.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';

let postgres: TestPostgres;
let orm: MikroORM;
const image = 'distributed-wagering-processor:task11';
const containers: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
	await command(['docker', 'build', '-t', image, '.']);
	postgres = await startPostgres();
	cleanup.push(postgres.close);
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
		throw new AggregateError(errors, 'Pending Docker cleanup');
}, 30000);

async function start(extra: Record<string, string> = {}): Promise<string> {
	const name = `dwp-pending-${crypto.randomUUID()}`;
	containers.push(name);
	const env = {
		POSTGRES_HOST: 'postgres',
		POSTGRES_PORT: '5432',
		POSTGRES_DB: postgres.env.POSTGRES_DB ?? '',
		POSTGRES_USER: postgres.env.POSTGRES_USER ?? '',
		POSTGRES_PASSWORD: postgres.env.POSTGRES_PASSWORD ?? '',
		PENDING_INSTANCE_ID: name,
		PENDING_POLL_MS: '20',
		PENDING_SQL_MS: '10000',
		PENDING_SHUTDOWN_MS: '25000',
		PENDING_LEASE_MS: '25000',
		PENDING_BATCH_SIZE: '1',
		PENDING_CONCURRENCY: '1',
		...extra,
	};
	await command([
		'docker',
		'run',
		'-d',
		'--name',
		name,
		'--network',
		postgres.network,
		...Object.entries(env).flatMap(([key, value]) => [
			'-e',
			`${key}=${value}`,
		]),
		image,
		'bun',
		'dist/main.pending-worker.js',
	]);
	await pendingUntil(
		async () =>
			(await command(['docker', 'logs', name])).includes('pending_ready'),
		'SQL-only worker ready',
		30000,
	);
	return name;
}
async function terminal(id: string): Promise<boolean> {
	return (
		(
			await orm.em.execute(
				"select id from wager_transactions where id = ? and status = 'PROCESSED'",
				[id],
			)
		).length === 1
	);
}
async function stop(name: string): Promise<void> {
	await command(['docker', 'kill', '--signal=SIGTERM', name]);
	const code = await command(['docker', 'wait', name]);
	if (code !== '0') {
		const logs = Bun.spawn(['docker', 'logs', name], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		console.error(
			await new Response(logs.stdout).text(),
			await new Response(logs.stderr).text(),
		);
		await logs.exited;
	}
	expect(code).toBe('0');
}

test('compiled standalone worker resolves without HTTP or SQS and handles real SIGTERM', async () => {
	const f = await seedPending(orm);
	const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
	await uc.execute(f.original);
	const name = await start();
	await pendingUntil(() => terminal(f.id), 'terminal financial commit');
	await stop(name);
	await reconciled(orm, f.wallet.id, '100.00', 3);
	expect(await uc.execute(f.pending)).toMatchObject({
		status: 'PROCESSED',
		idempotentReplay: true,
	});
}, 60000);

test('SIGTERM while blocked on wallet stops acquisition and drains the started atomic resolution', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const lock = orm.em.fork();
	await lock.begin();
	let name: string | undefined;
	try {
		await lock.execute('select id from wallets where id = ? for update', [
			f.wallet.id,
		]);
		name = await start();
		await pendingUntil(
			async () =>
				(
					await orm.em.execute(
						"select pid from pg_stat_activity where application_name like 'pending-worker-%' and wait_event_type = 'Lock'",
					)
				).length === 1,
			'worker waiting for wallet',
		);
		await command(['docker', 'kill', '--signal=SIGTERM', name]);
		const running = name;
		await pendingUntil(
			async () =>
				(await command(['docker', 'logs', running])).includes(
					'pending_stopping',
				),
			'signal handler entered',
		);
		expect(await terminal(f.id)).toBe(false);
	} finally {
		await lock.rollback();
	}
	expect(await command(['docker', 'wait', name])).toBe('0');
	expect(await terminal(f.id)).toBe(true);
	await reconciled(orm, f.wallet.id, '100.00', 3);
}, 60000);

test('SQL timeout leaves nonterminal snapshot and scheduled retry; restart resolves without partial money', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const lock = orm.em.fork();
	await lock.begin();
	let name: string | undefined;
	try {
		await lock.execute('select id from wallets where id = ? for update', [
			f.wallet.id,
		]);
		name = await start({
			PENDING_SQL_MS: '500',
			PENDING_LEASE_MS: '4000',
			PENDING_SHUTDOWN_MS: '5000',
		});
		await pendingUntil(
			async () =>
				(
					await orm.em.execute(
						"select id from wager_transactions where id = ? and last_error = 'SQL_UNCERTAIN' and next_attempt_at > clock_timestamp() and claim_token is null",
						[f.id],
					)
				).length === 1,
			'durable retry after actual SQL timeout',
		);
		await stop(name);
		await reconciled(orm, f.wallet.id, '20.00', 2);
		expect(await terminal(f.id)).toBe(false);
	} finally {
		await lock.rollback();
	}
	name = await start();
	await pendingUntil(() => terminal(f.id), 'restart resolves retry');
	await stop(name);
	await reconciled(orm, f.wallet.id, '100.00', 3);
}, 60000);

test('SIGTERM deadline during a real PostgreSQL pause exits 1 and another worker recovers the claim', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const database = await command([
		'docker',
		'ps',
		'--filter',
		`network=${postgres.network}`,
		'--filter',
		'label=com.docker.compose.service=postgres',
		'--format',
		'{{.ID}}',
	]);
	if (database === '' || database.includes('\n'))
		throw new Error('Cannot identify isolated test database');
	const lock = orm.em.fork();
	await lock.begin();
	let paused = false;
	try {
		await lock.execute('select id from wallets where id = ? for update', [
			f.wallet.id,
		]);
		const name = await start({
			PENDING_SQL_MS: '2000',
			PENDING_LEASE_MS: '8000',
			PENDING_SHUTDOWN_MS: '8000',
		});
		await pendingUntil(
			async () =>
				(
					await orm.em.execute(
						"select pid from pg_stat_activity where application_name like 'pending-worker-%' and wait_event_type = 'Lock'",
					)
				).length === 1,
			'in-flight SQL before pause',
		);
		await command(['docker', 'pause', database]);
		paused = true;
		await command(['docker', 'kill', '--signal=SIGTERM', name]);
		expect(await command(['docker', 'wait', name])).toBe('1');
		const logs = Bun.spawn(['docker', 'logs', name], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr] = await Promise.all([
			new Response(logs.stdout).text(),
			new Response(logs.stderr).text(),
		]);
		await logs.exited;
		expect(stdout).toContain('pending_stopping');
		expect(stderr).toContain('pending_shutdown_deadline');
	} finally {
		if (paused) await command(['docker', 'unpause', database]);
		await lock.rollback();
	}
	await reconciled(orm, f.wallet.id, '20.00', 2);
	expect(await terminal(f.id)).toBe(false);
	const successor = await start();
	await pendingUntil(() => terminal(f.id), 'deadline recovery');
	await stop(successor);
	await reconciled(orm, f.wallet.id, '100.00', 3);
}, 60000);
