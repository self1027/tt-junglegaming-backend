import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';

let postgres: TestPostgres;
let orm: MikroORM;
beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await orm.migrator.up();
}, 90000);
afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		if (typeof postgres !== 'undefined') await postgres.close();
	}
}, 30000);

async function violation(
	sql: string,
	params: unknown[] = [],
): Promise<unknown> {
	const error: unknown = await orm.em.execute(sql, params).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toMatchObject({ code: '55000' });
	return error;
}

test('terminal wager history rejects direct SQL mutation/deletion and survives migration down/up', async () => {
	const player = crypto.randomUUID();
	const wallet = crypto.randomUUID();
	await orm.em.execute(
		"insert into wallets (id, player_id, currency, balance) values (?, ?, 'BRL', 0.00)",
		[wallet, player],
	);
	const ids = [];
	for (const status of [
		'PROCESSED',
		'REJECTED',
		'FAILED',
		'PENDING_REFERENCE',
	]) {
		const id = crypto.randomUUID();
		ids.push(id);
		await orm.em.execute(
			`insert into wager_transactions
			(id, wallet_id, player_id, provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id, failure_code, processed_at)
			values (?, ?, ?, 'provider', ?, ?, 'hash', 'round', 'game', 'WIN', ?, 1.00, 'BRL', ?, ?, ?)`,
			[
				id,
				wallet,
				player,
				id,
				id,
				status,
				status === 'PENDING_REFERENCE' ? 'missing' : null,
				status === 'REJECTED' || status === 'FAILED'
					? 'TEST_FAILURE'
					: null,
				status === 'PROCESSED' ? new Date() : null,
			],
		);
		if (status === 'PENDING_REFERENCE') {
			await orm.em.execute(
				"update wager_transactions set attempts = 1, next_attempt_at = clock_timestamp(), claim_token = gen_random_uuid(), claimed_by = 'worker', claimed_until = clock_timestamp() + interval '30 seconds' where id = ?",
				[id],
			);
			await orm.em.execute(
				"update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND_EXHAUSTED', claim_token = null, claimed_by = null, claimed_until = null where id = ?",
				[id],
			);
		}
		for (const assignment of [
			"status = 'PENDING'",
			'amount = 2.00',
			"provider_id = 'other'",
			'attempts = attempts + 1',
		])
			await violation(
				`update wager_transactions set ${assignment} where id = ?`,
				[id],
			);
		await violation('delete from wager_transactions where id = ?', [id]);
	}
	expect(
		await violation('truncate wager_transactions cascade'),
	).toMatchObject({
		message: 'Wager history cannot be truncated',
	});
	const before = await orm.em.execute(
		'select * from wager_transactions order by id',
	);
	await orm.migrator.down({ to: 'Migration202610290002' });
	expect(await orm.migrator.getPending()).toHaveLength(2);
	await orm.migrator.up();
	expect(
		await orm.em.execute('select * from wager_transactions order by id'),
	).toEqual(before);
	await violation('delete from wager_transactions where id = ?', [ids[0]]);
});
