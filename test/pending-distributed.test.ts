import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import {
	seedPending,
	pendingCommand,
	pendingUntil,
	reconciled,
} from './support/pending.js';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import {
	WagerTransactionRow,
	OutboxMessageRow,
	IdempotencyRecordRow,
} from '../src/platform/persistence/models.js';
import type { ProcessWagerCommand } from '../src/modules/wagering/public/process-wager.js';
import { wagerChild } from './support/wager-child.js';

let postgres: TestPostgres;
let orm: MikroORM;
const cleanup: (() => Promise<void>)[] = [];
const children: ReturnType<typeof wagerChild>[] = [];
beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
}, 120000);
afterEach(async () => {
	try {
		await Promise.all(children.splice(0).map(c => c.close()));
	} finally {
		await orm.em.execute(
			"update wager_transactions set next_attempt_at = clock_timestamp() + interval '1 day', claim_token = null, claimed_by = null, claimed_until = null where status in ('PENDING', 'PENDING_REFERENCE')",
		);
	}
}, 30000);
afterAll(async () => {
	for (const close of cleanup.reverse()) await close();
}, 30000);

function child(
	input: ProcessWagerCommand,
	mode = 'normal',
	leaseMs = 30000,
): ReturnType<typeof wagerChild> {
	const c = wagerChild(
		{ ...postgres.env, PENDING_TEST_LEASE_MS: String(leaseMs) },
		input,
		mode,
		'test/support/pending-process.ts',
	);
	children.push(c);
	return c;
}
async function waiting(pid: number): Promise<void> {
	await pendingUntil(
		async () =>
			(
				await orm.em.execute(
					'select pid from pg_stat_activity where application_name = ? and wait_event_type = ?',
					[`pending-test-${String(pid)}`, 'Lock'],
				)
			).length > 0,
		'real SQL contention',
	);
}

test('three independent workers simultaneously claim the same pending reversal; one financial effect', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const workers = [
		child(f.pending, 'hold-claim'),
		child(f.pending),
		child(f.pending),
	];
	for (const c of workers) expect(await c.next()).toBe('ready');
	await workers[0]?.signal();
	expect(await workers[0]?.next()).toBe('claimed');
	await Promise.all(workers.slice(1).map(c => c.signal()));
	expect(await workers[1]?.next()).toBe('EMPTY');
	expect(await workers[2]?.next()).toBe('EMPTY');
	await workers[0]?.signal();
	expect(await workers[0]?.next()).toBe('PROCESSED');
	await reconciled(orm, f.wallet.id, '100.00', 3);
	expect(
		await orm.em.fork().count(OutboxMessageRow, { correlationId: f.id }),
	).toBe(3);
	expect(
		(
			await orm.em
				.fork()
				.findOneOrFail(IdempotencyRecordRow, { transactionId: f.id })
		).originalResult,
	).toMatchObject({ status: 'PROCESSED' });
});

test('REFUND and ROLLBACK workers compete after BET; third process replays without cumulative credit', async () => {
	const f = await seedPending(orm);
	const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
	const rollback = pendingCommand(f.wallet, {
		kind: 'ROLLBACK',
		referenceExternalTransactionId: f.original.externalTransactionId,
	});
	const r = await uc.execute(rollback);
	await uc.execute(f.original);
	const a = child(f.pending, 'hold-commit');
	const b = child(rollback);
	const replay = wagerChild(postgres.env, f.pending);
	children.push(replay);
	for (const c of [a, b, replay]) expect(await c.next()).toBe('ready');
	await a.signal();
	expect(await a.next()).toBe('before-commit');
	await b.signal();
	await waiting(b.pid);
	await replay.signal();
	await pendingUntil(
		async () =>
			(
				await orm.em.execute(
					'select pid from pg_stat_activity where application_name = ? and wait_event_type = ?',
					[`wager-test-${String(replay.pid)}`, 'Lock'],
				)
			).length > 0,
		'idempotent replay waits for resolution',
	);
	await a.signal();
	expect(await a.next()).toBe('PROCESSED');
	expect(await b.next()).toBe('REJECTED');
	expect(await replay.next()).toBe('REPLAY');
	expect(await uc.execute(rollback)).toMatchObject({
		status: 'REJECTED',
		failureCode: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
	});
	expect(
		(
			await orm.em
				.fork()
				.findOneOrFail(WagerTransactionRow, { id: r.transactionId })
		).failureCode,
	).toBe('CUMULATIVE_REVERSAL_NOT_ALLOWED');
	await reconciled(orm, f.wallet.id, '100.00', 3);
});

test.each(['crash-before-commit', 'crash-after-commit'] as const)(
	'%s: kill at a verified SQL boundary and recover in a third process',
	async mode => {
		const f = await seedPending(orm);
		await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(
			f.original,
		);
		const a = child(f.pending, mode, 10000);
		const b = child(f.pending);
		const c = child(f.pending);
		for (const p of [a, b, c]) expect(await p.next()).toBe('ready');
		await a.signal();
		expect(await a.next()).toBe(
			mode === 'crash-before-commit'
				? 'before-commit'
				: 'committed-before-response',
		);
		if (mode === 'crash-before-commit') {
			await reconciled(orm, f.wallet.id, '20.00', 2);
			expect(
				(
					await orm.em.fork().findOneOrFail(IdempotencyRecordRow, {
						transactionId: f.id,
					})
				).originalResult,
			).toMatchObject({ status: 'PENDING_REFERENCE' });
			expect(
				await orm.em
					.fork()
					.count(OutboxMessageRow, { correlationId: f.id }),
			).toBe(1);
		} else await reconciled(orm, f.wallet.id, '100.00', 3);
		await a.kill();
		if (mode === 'crash-before-commit') {
			await pendingUntil(
				async () =>
					(
						await orm.em.execute(
							'select id from wager_transactions where id = ? and claimed_until <= clock_timestamp()',
							[f.id],
						)
					).length === 1,
				'lease expires after actual process death',
				15000,
			);
		}
		await b.signal();
		expect(await b.next()).toBe(
			mode === 'crash-before-commit' ? 'PROCESSED' : 'EMPTY',
		);
		await c.signal();
		expect(await c.next()).toBe('EMPTY');
		await reconciled(orm, f.wallet.id, '100.00', 3);
		expect(
			await orm.em
				.fork()
				.count(OutboxMessageRow, { correlationId: f.id }),
		).toBe(3);
	},
	30000,
);

test('stale process cannot finalize after actual lease expiry and reacquisition by another process', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const a = child(f.pending, 'hold-claim', 1500);
	const b = child(f.pending, 'hold-claim');
	const c = child(f.pending);
	for (const p of [a, b, c]) expect(await p.next()).toBe('ready');
	await a.signal();
	expect(await a.next()).toBe('claimed');
	await pendingUntil(
		async () =>
			(
				await orm.em.execute(
					'select id from wager_transactions where id = ? and claimed_until <= clock_timestamp()',
					[f.id],
				)
			).length === 1,
		'lease expired',
	);
	await b.signal();
	expect(await b.next()).toBe('claimed');
	const token = (
		await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: f.id })
	).claimToken;
	await a.signal();
	expect(await a.next()).toBe('CLAIM_LOST');
	expect(
		(await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: f.id }))
			.claimToken,
	).toBe(token);
	await b.signal();
	expect(await b.next()).toBe('PROCESSED');
	await c.signal();
	expect(await c.next()).toBe('EMPTY');
	await reconciled(orm, f.wallet.id, '100.00', 3);
}, 20000);

test('original WIN/BET held before commit, worker on same wallet, and independent wallet progress without lock inversion', async () => {
	for (const kind of ['BET', 'WIN'] as const) {
		const f = await seedPending(
			orm,
			'100.00',
			kind === 'BET' ? 'REFUND' : 'ROLLBACK',
			kind,
		);
		const g = await seedPending(orm);
		await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(
			g.original,
		);
		const original = wagerChild(postgres.env, f.original, 'hold-commit');
		children.push(original);
		const same = child(f.pending);
		const other = child(g.pending);
		for (const p of [original, same, other])
			expect(await p.next()).toBe('ready');
		await original.signal();
		expect(await original.next()).toBe('before-commit');
		await same.signal();
		await waiting(same.pid);
		await other.signal();
		expect(await other.next()).toBe('PROCESSED');
		await reconciled(orm, g.wallet.id, '100.00', 3);
		await original.signal();
		expect(await original.next()).toBe('PROCESSED');
		expect(await same.next()).toBe('PROCESSED');
		await reconciled(orm, f.wallet.id, '100.00', 3);
	}
}, 30000);
