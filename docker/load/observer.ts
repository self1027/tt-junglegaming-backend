import { SQL } from 'bun';
import { assertInvariant } from './core.js';

export interface Point {
	at: string;
	confirmed: number;
	transactions: number;
	events: number;
	published: number;
	pending: number;
	oldestPendingMs: number;
	publicationRetries: number;
	inboxProcessed: number;
	inboxExtraAttempts: number;
	deadlocks: number;
	statsReset: string | null;
	lockWaiters: number;
	walletLockWaiters: number;
	clients: string[];
	claimOwners: string[];
}
export interface FinancialRow {
	id: string;
	balance: string;
	initial: string;
	calculated: string;
	version: number;
	entries: number;
	debits: number;
	bets: number;
	invalid: number;
}

export function validateFinancial(
	rows: FinancialRow[],
	walletCount: number,
	initial: string,
): void {
	assertInvariant(rows.length === walletCount, 'missing wallet');
	for (const row of rows) {
		assertInvariant(row.initial === initial, `${row.id}: opening balance`);
		assertInvariant(
			row.balance === row.calculated,
			`${row.id}: balance != ledger`,
		);
		assertInvariant(
			row.entries === row.debits + 1 && row.bets === row.debits,
			`${row.id}: one debit per confirmed BET`,
		);
		assertInvariant(
			row.version === row.debits + 1,
			`${row.id}: wallet version`,
		);
		assertInvariant(
			row.invalid === 0,
			`${row.id}: negative/disconnected/duplicate ledger, operation, idempotency or event`,
		);
	}
}

export class Observer {
	constructor(
		readonly sql = new SQL({
			hostname: 'postgres',
			port: 5432,
			database: 'wagering_demo',
			username: 'wagering_demo',
			password: 'local-demo-only',
			max: 1,
			connectionTimeout: 5,
			connection: {
				default_transaction_read_only: 'on',
				statement_timeout: '5000',
				application_name: 'load-observer',
			},
		}),
	) {}

	async point(provider: string): Promise<Point> {
		const rows = await this.sql<Point[]>`
		with tx as (select * from wager_transactions where provider_id = ${provider}),
		events as (select o.* from outbox_messages o join tx t on o.correlation_id = t.id::text),
		inbox as (select * from inbox_messages where message_id like ${`${provider}:%`}),
		activity as (select * from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid())
		select clock_timestamp()::text as at,
		(select count(*)::int from tx where status = 'PROCESSED') as confirmed,
		(select count(*)::int from tx) as transactions,
		(select count(*)::int from events) as events,
		(select count(*)::int from events where status = 'PUBLISHED') as published,
		(select count(*)::int from events where status = 'PENDING') as pending,
		(select coalesce(greatest(0, extract(epoch from (clock_timestamp() - min(created_at))) * 1000), 0)::float8 from events where status = 'PENDING') as "oldestPendingMs",
		(select coalesce(sum(greatest(attempts - 1, 0)), 0)::int from events) as "publicationRetries",
		(select count(*)::int from inbox where status = 'PROCESSED') as "inboxProcessed",
		(select coalesce(sum(greatest(attempts - 1, 0)), 0)::int from inbox) as "inboxExtraAttempts",
		deadlocks::int, stats_reset::text as "statsReset",
		(select count(*)::int from activity where wait_event_type = 'Lock') as "lockWaiters",
		(select count(*)::int from activity where wait_event_type = 'Lock' and query ilike '%wallets%' and query ilike '%for update%') as "walletLockWaiters",
		(select coalesce(jsonb_agg(distinct host(client_addr) || ':' || pid::text), '[]'::jsonb) from activity where client_addr is not null) as clients,
		(select coalesce(jsonb_agg(distinct claimed_by), '[]'::jsonb) from events where claimed_by is not null) as "claimOwners"
		from pg_stat_database where datname = current_database()`;
		const row = rows[0];
		if (row === undefined)
			throw new Error('Missing PostgreSQL observation');
		return row;
	}

	async publication(provider: string): Promise<Record<string, unknown>> {
		const rows = await this.sql<Record<string, unknown>[]>`
		with events as (
			select o.*, extract(epoch from (o.published_at - o.created_at)) * 1000 as lag
			from outbox_messages o join wager_transactions t on o.correlation_id = t.id::text
			where t.provider_id = ${provider}
		)
		select count(*) filter (where status = 'PUBLISHED')::int as samples,
		percentile_disc(0.50) within group (order by lag)::float8 as p50,
		percentile_disc(0.95) within group (order by lag)::float8 as p95,
		percentile_disc(0.99) within group (order by lag)::float8 as p99,
		max(lag)::float8 as max,
		count(*) filter (where published_at < created_at)::int as "negativeIntervals"
		from events`;
		return rows[0] ?? {};
	}

	async processing(provider: string): Promise<Record<string, unknown>> {
		const rows = await this.sql<Record<string, unknown>[]>`
		select count(*)::int as samples,
		percentile_disc(0.50) within group (order by extract(epoch from (processed_at - created_at)) * 1000)::float8 as p50,
		percentile_disc(0.95) within group (order by extract(epoch from (processed_at - created_at)) * 1000)::float8 as p95,
		percentile_disc(0.99) within group (order by extract(epoch from (processed_at - created_at)) * 1000)::float8 as p99
		from wager_transactions where provider_id = ${provider} and status = 'PROCESSED'`;
		return rows[0] ?? {};
	}

	async reconcile(
		walletIds: string[],
		initial: string,
	): Promise<FinancialRow[]> {
		const rows = await this.sql<FinancialRow[]>`
		with selected as (select value::uuid as id from jsonb_array_elements_text(${JSON.stringify(walletIds)}::text::jsonb)),
		ledger as (
			select l.wallet_id,
			count(*)::int as entries,
			count(*) filter (where direction = 'DEBIT')::int as debits,
			count(*) filter (where direction = 'CREDIT')::int as credits,
			coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as initial,
			sum(case when direction = 'CREDIT' then amount else -amount end)::text as calculated,
			min(balance_after) as lowest, max(balance_before) filter (where direction = 'DEBIT') as highest,
			count(distinct balance_before) filter (where direction = 'DEBIT')::int as starts,
			count(*) filter (where balance_before < 0 or balance_after < 0 or
				(direction = 'DEBIT' and (amount <> 1.00 or balance_before - amount <> balance_after)) or
				(direction = 'CREDIT' and (balance_before <> 0 or balance_after <> amount)))::int as bad
			from wallet_ledger_entries l join selected s on s.id = l.wallet_id group by l.wallet_id
		),
		tx as (select t.* from wager_transactions t join selected s on s.id = t.wallet_id),
		facts as (
			select t.id, count(o.id) as nevents,
			count(o.id) filter (where o.payload->'data'->>'transactionId' = t.id::text and o.event_type = 'WagerTransactionProcessed' and o.status = 'PUBLISHED') as nprocessed,
			count(o.id) filter (where o.payload->'data'->>'transactionId' = t.id::text and o.payload->'data'->>'walletId' = t.wallet_id::text and o.event_type = 'WalletBalanceChanged' and o.status = 'PUBLISHED') as nbalance
			from tx t left join outbox_messages o on o.correlation_id = t.id::text group by t.id
		),
		effects as (
			select t.id, count(l.id) as nledger, max(l.balance_after)::text as balance_after
			from tx t left join wallet_ledger_entries l on l.transaction_id = t.id and l.wallet_id = t.wallet_id group by t.id
		),
		identities as (
			select t.id, count(i.id) filter (where i.status = 'COMPLETED' and i.original_result->>'transactionId' = t.id::text
				and i.original_result->>'status' = t.status and i.original_result->'balance'->>'amount' = e.balance_after) as nidempotency
			from tx t join effects e on e.id = t.id left join idempotency_records i on i.transaction_id = t.id group by t.id
		),
		operations as (
			select t.*, f.nevents, f.nprocessed, f.nbalance, e.nledger, i.nidempotency
			from tx t join facts f on f.id = t.id join effects e on e.id = t.id join identities i on i.id = t.id
		),
		checks as (
			select wallet_id,
			count(*) filter (where kind = 'BET' and status = 'PROCESSED')::int as bets,
			count(*) filter (where kind = 'OPENING')::int as openings,
			count(*) filter (where
				(kind = 'OPENING' and (status <> 'PROCESSED' or amount <> ${initial}::numeric or nledger <> 1 or nevents <> 0)) or
				(kind <> 'OPENING' and (kind <> 'BET' or status <> 'PROCESSED' or amount <> 1.00 or nledger <> 1 or nidempotency <> 1 or nevents <> 2 or nprocessed <> 1 or nbalance <> 1)))::int as bad
			from operations group by wallet_id
		)
		select w.id, w.balance::text, l.initial, l.calculated, w.version, l.entries, l.debits, c.bets,
		(l.bad + c.bad + case when w.balance < 0 or l.lowest <> w.balance or l.credits <> 1 or c.openings <> 1 or
			l.starts <> l.debits or (l.debits > 0 and l.highest <> ${initial}::numeric) then 1 else 0 end)::int as invalid
		from wallets w join selected s on s.id = w.id
		join ledger l on l.wallet_id = w.id join checks c on c.wallet_id = w.id`;
		validateFinancial(rows, walletIds.length, initial);
		return rows;
	}
}
