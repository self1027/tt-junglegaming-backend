import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import { WagerTransactionRow } from '../../../../platform/persistence/models.js';
import { PendingClaimLostError } from '../../public/pending.js';
import type {
	PendingWagerClaim,
	PendingWagerStore,
	PendingResolutionRepository,
} from '../../public/pending.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import { wagerToDomain } from './mappers.js';

export class MikroOrmPendingWagerStore implements PendingWagerStore {
	constructor(private readonly manager: EntityManager) {}

	async claim(
		limit: number,
		owner: string,
		leaseMs: number,
	): Promise<readonly PendingWagerClaim[]> {
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			!Number.isSafeInteger(leaseMs) ||
			leaseMs < 1 ||
			!/^[a-zA-Z0-9._:-]{1,128}$/.test(owner)
		)
			throw new Error('Invalid pending claim');
		return this.manager
			.fork({ useContext: false, keepTransactionContext: false })
			.transactional(async em => {
				const rows = await em.execute<Record<string, unknown>[]>(
					`
				with eligible as (
					select id from wager_transactions
					where status in ('PENDING', 'PENDING_REFERENCE') and reference_external_transaction_id is not null
						and kind <> 'OPENING' and coalesce(next_attempt_at, created_at) <= statement_timestamp()
						and (claimed_until is null or claimed_until <= clock_timestamp())
					order by coalesce(next_attempt_at, created_at), created_at, id
					for update skip locked limit ?
				)
				update wager_transactions w set claim_token = gen_random_uuid(), claimed_by = ?,
					claimed_until = clock_timestamp() + (? * interval '1 millisecond'),
					attempts = w.attempts + 1, last_attempt_at = clock_timestamp()
				from eligible e where w.id = e.id returning w.*
			`,
					[limit, owner, leaseMs],
				);
				return rows.map(raw => {
					const row = em.map(WagerTransactionRow, raw);
					if (row.claimToken == null)
						throw new Error('Incomplete pending claim');
					return {
						transaction: wagerToDomain(row),
						token: row.claimToken,
						attempts: row.attempts,
					};
				});
			});
	}

	async retry(claim: PendingWagerClaim, delayMs: number): Promise<void> {
		if (!Number.isSafeInteger(delayMs) || delayMs < 1)
			throw new Error('Invalid pending retry');
		await this.manager
			.fork({ useContext: false, keepTransactionContext: false })
			.execute(
				`
			update wager_transactions set next_attempt_at = clock_timestamp() + (? * interval '1 millisecond'),
				last_error = 'SQL_UNCERTAIN', claim_token = null, claimed_by = null, claimed_until = null
			where id = ? and claim_token = ? and status in ('PENDING', 'PENDING_REFERENCE')
				and claimed_until > clock_timestamp()
		`,
				[delayMs, claim.transaction.id, claim.token],
			);
	}
}

export class MikroOrmPendingResolutionRepository implements PendingResolutionRepository {
	constructor(private readonly session: TransactionSession) {}

	async lock(
		claim: PendingWagerClaim,
		ttlMs: number,
	): Promise<
		| { transaction: WagerTransaction; at: Date; expired: boolean }
		| undefined
	> {
		const em = this.session.em;
		const rows = await em.execute<Record<string, unknown>[]>(
			`
			select *, clock_timestamp() as decision_at,
				created_at + (? * interval '1 millisecond') <= clock_timestamp() as expired
			from wager_transactions where id = ? and claim_token = ?
				and status in ('PENDING', 'PENDING_REFERENCE') and claimed_until > clock_timestamp() for update
		`,
			[ttlMs, claim.transaction.id, claim.token],
		);
		const raw = rows[0];
		if (raw === undefined) return undefined;
		const at =
			raw.decision_at instanceof Date
				? raw.decision_at
				: new Date(String(raw.decision_at));
		return {
			transaction: wagerToDomain(em.map(WagerTransactionRow, raw)),
			at,
			expired: raw.expired === true,
		};
	}

	async finish(
		claim: PendingWagerClaim,
		transaction: WagerTransaction,
		delayMs: number,
		reason: string | undefined,
	): Promise<void> {
		if (
			transaction.id !== claim.transaction.id ||
			!Number.isSafeInteger(delayMs) ||
			delayMs < 1
		)
			throw new Error('Invalid pending completion');
		const changed = await this.session.em.execute<{ id: string }[]>(
			`
			update wager_transactions set status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ?,
				next_attempt_at = case when ? then null else clock_timestamp() + (? * interval '1 millisecond') end,
				last_error = ?, updated_at = clock_timestamp(), claim_token = null, claimed_by = null, claimed_until = null
			where id = ? and claim_token = ? and status = ? and status in ('PENDING', 'PENDING_REFERENCE')
				and claimed_until > clock_timestamp() returning id
		`,
			[
				transaction.status,
				transaction.referenceTransactionId ?? null,
				transaction.failureCode ?? null,
				transaction.processedAt ?? null,
				transaction.isTerminal(),
				delayMs,
				reason ?? null,
				transaction.id,
				claim.token,
				claim.transaction.status,
			],
		);
		if (changed.length !== 1) throw new PendingClaimLostError();
	}
}
