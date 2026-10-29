import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmOutboxStore } from '../src/platform/persistence/mikro-orm-outbox-store.js';
import { OutboxMessageRow } from '../src/platform/persistence/models.js';
import { command, startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { exampleEvents } from './support/outbox.js';
import type { OutboxClaim } from '../src/platform/messaging/outbox.js';

let postgres: TestPostgres;
let orm: MikroORM;
let independent: MikroORM;
let store: MikroOrmOutboxStore;
let other: MikroOrmOutboxStore;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
	independent = await testOrm(postgres);
	cleanup.push(() => independent.close(true));
	store = new MikroOrmOutboxStore(orm.em);
	other = new MikroOrmOutboxStore(independent.em);
}, 120000);
afterEach(async () => {
	await orm.em.execute('delete from outbox_messages');
});
afterAll(async () => {
	const errors: unknown[] = [];
	for (const close of cleanup.reverse()) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0)
		throw new AggregateError(errors, 'Outbox SQL cleanup failed');
}, 30000);

async function seed(count = 1): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const event = exampleEvents()[0];
		if (event === undefined) throw new Error('Missing fixture');
		ids.push(event.eventId);
		await orm.em.fork().insert(OutboxMessageRow, {
			eventId: event.eventId,
			aggregateId: event.aggregateId,
			eventType: event.eventType,
			eventVersion: 1,
			correlationId: event.correlationId,
			causationId: event.causationId,
			payload: event.toJSON(),
			occurredAt: event.occurredAt,
		});
	}
	return ids;
}
function first(claims: readonly OutboxClaim[]): OutboxClaim {
	const claim = claims[0];
	if (claim === undefined) throw new Error('Missing claim');
	return claim;
}

test('incremental migration down/status/up preserves legacy pending and published envelopes', async () => {
	await orm.migrator.down({ to: 'Migration202610280002' });
	const ids = await seed();
	const id = ids[0];
	await orm.em.execute(
		"insert into outbox_messages (event_id, aggregate_id, event_type, event_version, correlation_id, payload, occurred_at, status, published_at) select gen_random_uuid(), aggregate_id, event_type, event_version, correlation_id, payload, occurred_at, 'PUBLISHED', clock_timestamp() from outbox_messages where event_id = ?",
		[id],
	);
	const before = await orm.em.execute(
		'select * from outbox_messages order by id',
	);
	expect(
		await command([process.execPath, 'run', 'db:status'], postgres.env),
	).toContain('Migration202610290001');
	await command([process.execPath, 'run', 'db:migrate'], postgres.env);
	expect(await orm.migrator.getPending()).toHaveLength(0);
	const after = await orm.em.execute<Record<string, unknown>[]>(
		'select * from outbox_messages order by id',
	);
	expect(
		after.map(
			({
				claim_token: _token,
				claimed_by: _by,
				claimed_until: _until,
				...row
			}) => row,
		),
	).toEqual(before);
	expect(await store.claim(10, 'legacy', 30000)).toHaveLength(1);
});

test('claims committed rows only, respects due time, batch limit and exclusive valid leases', async () => {
	await seed(5);
	await orm.em.execute(
		"update outbox_messages set next_attempt_at = clock_timestamp() + interval '1 hour' where id = (select id from outbox_messages order by id limit 1)",
	);
	const [a, b] = await Promise.all([
		store.claim(2, 'a', 30000),
		other.claim(2, 'b', 30000),
	]);
	expect(a).toHaveLength(2);
	expect(b).toHaveLength(2);
	expect(new Set([...a, ...b].map(row => row.eventId)).size).toBe(4);
	expect(new Set([...a, ...b].map(row => row.token)).size).toBe(4);
	for (const row of [...a, ...b]) {
		expect(row.attempts).toBe(1);
		expect(row.recovered).toBe(false);
	}
	expect(await store.claim(10, 'third', 30000)).toEqual([]);
	expect((await store.diagnostics()).pending).toBe(5);
	const em = orm.em.fork();
	await em.begin();
	try {
		await em.execute(
			"insert into outbox_messages (event_id, aggregate_id, event_type, event_version, correlation_id, payload, occurred_at) values (?, ?, 'WagerTransactionProcessed', 1, 'test', '{}'::jsonb, clock_timestamp())",
			[crypto.randomUUID(), crypto.randomUUID()],
		);
		expect(await other.claim(10, 'outside', 30000)).toEqual([]);
	} finally {
		await em.rollback();
	}
});

test('SKIP LOCKED passes a genuinely locked oldest row without waiting or a global lock', async () => {
	await seed(3);
	const blocker = independent.em.fork();
	await blocker.begin();
	try {
		const locked = await blocker.execute<{ event_id: string }[]>(
			'select event_id from outbox_messages order by next_attempt_at, created_at, id limit 1 for update',
		);
		const claimed = await store.claim(3, 'skip', 30000);
		expect(claimed).toHaveLength(2);
		expect(claimed.map(row => row.eventId)).not.toContain(
			locked[0]?.event_id,
		);
	} finally {
		await blocker.rollback();
	}
	expect(await store.claim(3, 'unlocked', 30000)).toHaveLength(1);
});

test('due-time predicate can bound the partial index rather than filtering the entire future backlog', async () => {
	await seed();
	const em = orm.em.fork();
	await em.begin();
	try {
		await em.execute('set local enable_seqscan = off');
		const plan = await em.execute(
			"explain select id from outbox_messages where status = 'PENDING' and next_attempt_at <= statement_timestamp() and (claimed_until is null or claimed_until <= clock_timestamp()) order by next_attempt_at, created_at, id for update skip locked limit 4",
		);
		expect(JSON.stringify(plan)).toContain(
			'Index Cond: (next_attempt_at <= statement_timestamp())',
		);
	} finally {
		await em.rollback();
	}
});

test('expired lease can be reclaimed with a new token; stale success and failure cannot touch its successor', async () => {
	await seed();
	const a = first(await store.claim(1, 'same-owner', 1));
	const deadline = Date.now() + 1000;
	let expired = false;
	while (!expired && Date.now() < deadline) {
		const rows = await orm.em.execute<{ expired: boolean }[]>(
			'select claimed_until <= clock_timestamp() as expired from outbox_messages',
		);
		expired = rows[0]?.expired === true;
	}
	expect(expired).toBe(true);
	expect(await store.published(a)).toBe('LEASE_EXPIRED');
	const b = first(await other.claim(1, 'same-owner', 30000));
	expect(b.token).not.toBe(a.token);
	expect(b.recovered).toBe(true);
	expect(b.attempts).toBe(2);
	expect(await store.published(a)).toBe('CLAIM_LOST');
	expect(await store.retry(a, 1000, 'SEND_UNCERTAIN')).toBe('CLAIM_LOST');
	const pending = await orm.em.execute<
		{ claim_token: string; status: string }[]
	>('select claim_token, status from outbox_messages');
	expect(pending[0]).toEqual({ claim_token: b.token, status: 'PENDING' });
	expect(await other.published(b)).toBe('UPDATED');
	expect(await store.published(a)).toBe('ALREADY_PUBLISHED');
	expect(await store.retry(a, 1000, 'SEND_UNCERTAIN')).toBe(
		'ALREADY_PUBLISHED',
	);
	expect(await other.published(b)).toBe('ALREADY_PUBLISHED');
	expect(await store.claim(1, 'later', 30000)).toEqual([]);
});

test('failure schedules SQL-clock retry, retains immutable envelope and increments attempts only on acquisition', async () => {
	await seed();
	const a = first(await store.claim(1, 'a', 30000));
	expect(await store.retry(a, 30000, 'THROTTLED')).toBe('UPDATED');
	expect(await store.claim(1, 'a', 30000)).toHaveLength(0);
	const row = await orm.em
		.fork()
		.findOneOrFail(OutboxMessageRow, { eventId: a.eventId });
	expect(row.status).toBe('PENDING');
	expect(row.publishedAt).toBeNull();
	expect(row.claimToken).toBeNull();
	expect(row.lastError).toBe('THROTTLED');
	expect(row.attempts).toBe(1);
	expect(row.payload).toEqual(a.payload);
	expect(row.occurredAt).toEqual(a.occurredAt);
	await orm.em.execute(
		'update outbox_messages set next_attempt_at = clock_timestamp() where event_id = ?',
		[a.eventId],
	);
	const b = first(await other.claim(1, 'b', 30000));
	expect(b.attempts).toBe(2);
	expect(b.payload).toEqual(a.payload);
	expect(await other.published(b)).toBe('UPDATED');
	const published = await orm.em
		.fork()
		.findOneOrFail(OutboxMessageRow, { eventId: a.eventId });
	expect(published.publishedAt).toBeInstanceOf(Date);
	expect(published.lastError).toBeNull();
	expect(published.claimToken).toBeNull();
	expect(published.payload).toEqual(a.payload);
});

test('claim consistency, immutable facts and irreversible PUBLISHED are protected by the schema', async () => {
	await seed();
	for (const sql of [
		"update outbox_messages set claimed_by = 'orphan'",
		"update outbox_messages set claim_token = gen_random_uuid(), claimed_by = 'x', claimed_until = 'infinity'",
		"update outbox_messages set payload = '{}'::jsonb",
		'update outbox_messages set occurred_at = clock_timestamp()',
	])
		expect(orm.em.execute(sql)).rejects.toMatchObject({ code: '23514' });
	const claim = first(await store.claim(1, 'a', 30000));
	await store.published(claim);
	expect(
		orm.em.execute(
			"update outbox_messages set status = 'PENDING', published_at = null",
		),
	).rejects.toMatchObject({ code: '23514' });
	const indexes = await orm.em.execute<{ indexdef: string }[]>(
		"select indexdef from pg_indexes where tablename = 'outbox_messages'",
	);
	expect(
		indexes.some(
			row =>
				row.indexdef.includes('next_attempt_at') &&
				row.indexdef.includes('PENDING'),
		),
	).toBe(true);
	expect(store.claim(0, 'x', 1000)).rejects.toThrow();
	expect(store.retry(claim, 1, 'secret details')).rejects.toThrow();
});
