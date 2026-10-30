import type { EntityManager } from '@mikro-orm/postgresql';
import type {
	ClaimResult,
	OutboxClaim,
	OutboxStore,
} from '../messaging/outbox.js';
import { OutboxMessageRow } from './models.js';

export class MikroOrmOutboxStore implements OutboxStore {
	constructor(private readonly manager: EntityManager) {}

	async claim(
		limit: number,
		owner: string,
		leaseMs: number,
	): Promise<readonly OutboxClaim[]> {
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			!Number.isSafeInteger(leaseMs) ||
			leaseMs < 1 ||
			owner.trim() === ''
		)
			throw new Error('Invalid Outbox claim');
		const em = this.manager.fork({
			useContext: false,
			keepTransactionContext: false,
		});
		return em.transactional(async tx => {
			const rows = await tx.execute<Record<string, unknown>[]>(
				`
				with eligible as (
					select id, claim_token is not null as recovered from outbox_messages
					where status = 'PENDING' and next_attempt_at <= statement_timestamp()
						and (claimed_until is null or claimed_until <= clock_timestamp())
					order by next_attempt_at, created_at, id
					for update skip locked limit ?
				)
				update outbox_messages o set claim_token = gen_random_uuid(), claimed_by = ?,
					claimed_until = clock_timestamp() + (? * interval '1 millisecond'),
					attempts = o.attempts + 1
				from eligible e where o.id = e.id returning o.*, e.recovered
			`,
				[limit, owner, leaseMs],
			);
			return rows.map(raw => {
				const row = tx.map(OutboxMessageRow, raw);
				if (row.claimToken == null || row.claimedUntil == null)
					throw new Error('Incomplete Outbox claim');
				return {
					eventId: row.eventId,
					eventType: row.eventType,
					eventVersion: row.eventVersion,
					aggregateId: row.aggregateId,
					correlationId: row.correlationId,
					causationId: row.causationId ?? null,
					occurredAt: row.occurredAt,
					payload: row.payload,
					token: row.claimToken,
					attempts: row.attempts,
					claimedUntil: row.claimedUntil,
					recovered: raw.recovered === true,
				};
			});
		});
	}

	async published(claim: OutboxClaim): Promise<ClaimResult> {
		return this.finish(
			claim,
			`status = 'PUBLISHED', published_at = clock_timestamp(), last_error = null`,
			[],
		);
	}

	async retry(
		claim: OutboxClaim,
		delayMs: number,
		code: string,
	): Promise<ClaimResult> {
		if (
			!Number.isSafeInteger(delayMs) ||
			delayMs < 1 ||
			!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)
		)
			throw new Error('Invalid Outbox retry');
		return this.finish(
			claim,
			`next_attempt_at = clock_timestamp() + (? * interval '1 millisecond'), last_error = ?`,
			[delayMs, code],
		);
	}

	private async finish(
		claim: OutboxClaim,
		assignment: string,
		params: unknown[],
	): Promise<ClaimResult> {
		const em = this.manager.fork({
			useContext: false,
			keepTransactionContext: false,
		});
		const changed = await em.execute<{ event_id: string }[]>(
			`
			update outbox_messages set ${assignment},
				claim_token = null, claimed_by = null, claimed_until = null
			where event_id = ? and claim_token = ? and status = 'PENDING'
				and claimed_until > clock_timestamp() returning event_id
		`,
			[...params, claim.eventId, claim.token],
		);
		if (changed.length === 1) return 'UPDATED';
		const rows = await em.execute<
			{ status: string; claim_token: string | null; expired: boolean }[]
		>(
			`
			select status, claim_token, claimed_until <= clock_timestamp() as expired
			from outbox_messages where event_id = ?
		`,
			[claim.eventId],
		);
		const current = rows[0];
		if (current === undefined) return 'MISSING';
		if (current.status === 'PUBLISHED') return 'ALREADY_PUBLISHED';
		if (current.claim_token !== claim.token) return 'CLAIM_LOST';
		return current.expired ? 'LEASE_EXPIRED' : 'CLAIM_LOST';
	}

	async diagnostics(): Promise<{
		pending: number;
		expired: number;
		lagMs: number;
	}> {
		const rows = await this.manager.fork().execute<
			{ pending: number; expired: number; lag_ms: number }[]
		>(`
			select count(*)::int as pending,
				count(*) filter (where claimed_until <= clock_timestamp())::int as expired,
				coalesce(greatest(0, extract(epoch from (clock_timestamp() - min(created_at))) * 1000), 0)::float8 as lag_ms
			from outbox_messages where status = 'PENDING'
		`);
		const row = rows[0];
		if (row === undefined) throw new Error('Missing Outbox diagnostics');
		return {
			pending: row.pending,
			expired: row.expired,
			lagMs: row.lag_ms,
		};
	}
}
