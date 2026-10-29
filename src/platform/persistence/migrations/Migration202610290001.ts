import { Migration } from '@mikro-orm/migrations';

export class Migration202610290001 extends Migration {
	override up(): void {
		this.addSql(`
			alter table outbox_messages
				add column claim_token uuid,
				add column claimed_by text,
				add column claimed_until timestamptz,
				add constraint outbox_claim_consistent check (
					(claim_token is null and claimed_by is null and claimed_until is null)
					or (status = 'PENDING' and claim_token is not null
						and claimed_by is not null and length(btrim(claimed_by)) > 0
						and claimed_until is not null and isfinite(claimed_until))
				);
			create function protect_outbox_history() returns trigger language plpgsql as $$
			begin
				if row(new.id, new.event_id, new.aggregate_id, new.event_type,
					new.event_version, new.correlation_id, new.causation_id,
					new.payload, new.occurred_at, new.created_at)
					is distinct from row(old.id, old.event_id, old.aggregate_id, old.event_type,
					old.event_version, old.correlation_id, old.causation_id,
					old.payload, old.occurred_at, old.created_at)
					or (old.status = 'PUBLISHED' and new is distinct from old) then
					raise exception 'Outbox history is immutable' using errcode = '23514';
				end if;
				return new;
			end $$;
			create trigger outbox_history_immutable before update on outbox_messages
				for each row execute function protect_outbox_history();
		`);
	}

	override down(): void {
		this.addSql(`
			drop trigger outbox_history_immutable on outbox_messages;
			drop function protect_outbox_history();
			alter table outbox_messages drop constraint outbox_claim_consistent,
				drop column claim_token, drop column claimed_by, drop column claimed_until;
		`);
	}
}
