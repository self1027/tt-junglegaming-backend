import { Migration } from '@mikro-orm/migrations';

export class Migration202610290002 extends Migration {
	override up(): void {
		this.addSql(`
			alter table wager_transactions add column claim_token uuid, add column claimed_by text,
				add column claimed_until timestamptz,
				add constraint wager_claim_consistent check (
					(claim_token is null and claimed_by is null and claimed_until is null) or
					(status in ('PENDING', 'PENDING_REFERENCE') and claim_token is not null and
					claimed_by is not null and length(btrim(claimed_by)) > 0 and
					claimed_until is not null and isfinite(claimed_until)));
			create index wager_pending_due_idx on wager_transactions (coalesce(next_attempt_at, created_at), created_at, id)
				where status in ('PENDING', 'PENDING_REFERENCE') and reference_external_transaction_id is not null and kind <> 'OPENING';
		`);
	}

	override down(): void {
		this.addSql(`
			drop index wager_pending_due_idx;
			alter table wager_transactions drop constraint wager_claim_consistent,
				drop column claim_token, drop column claimed_by, drop column claimed_until;
		`);
	}
}
