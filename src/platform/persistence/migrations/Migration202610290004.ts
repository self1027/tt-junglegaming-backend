import { Migration } from '@mikro-orm/migrations';

export class Migration202610290004 extends Migration {
	override up(): void {
		this.addSql(`
			create function protect_active_bet_compensation() returns trigger language plpgsql as $$
			declare original wager_transactions%rowtype;
			begin
				if tg_op = 'UPDATE' then
					if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then return new; end if;
				end if;
				if new.status <> 'PROCESSED' or new.kind not in ('REFUND', 'ROLLBACK') then return new; end if;
				-- Same wallet coordination as the application, never a lock on another reversal.
				perform 1 from wallets where id = new.wallet_id for update;
				select * into original from wager_transactions where id = new.reference_transaction_id;
				if not found then return new; end if;
				if original.status <> 'PROCESSED' then
					raise exception 'Reversal reference is not processed' using errcode = '23514', constraint = 'wager_active_bet_compensation_check';
				end if;
				if new.wallet_id is distinct from original.wallet_id then
					raise exception 'Reversal wallet differs from its reference' using errcode = '23514', constraint = 'wager_active_bet_compensation_check';
				end if;
				if original.kind = 'BET' and (
					(new.wallet_id, new.player_id, new.provider_id, new.currency, new.round_id, new.amount, new.reference_external_transaction_id)
					is distinct from
					(original.wallet_id, original.player_id, original.provider_id, original.currency, original.round_id, original.amount, original.external_transaction_id)) then
					raise exception 'Invalid BET compensation reference' using errcode = '23514', constraint = 'wager_active_bet_compensation_check';
				end if;
				if exists (select 1 from wager_transactions other
					where other.reference_transaction_id = original.id and other.status = 'PROCESSED'
						and other.kind in ('REFUND', 'ROLLBACK') and other.kind <> new.kind and other.id <> new.id) then
					if original.kind <> 'BET' or new.kind <> 'ROLLBACK' or not exists (
						select 1 from wager_transactions refund
						join wager_transactions rollback on rollback.reference_transaction_id = refund.id
						where refund.reference_transaction_id = original.id and refund.kind = 'REFUND' and refund.status = 'PROCESSED'
							and rollback.kind = 'ROLLBACK' and rollback.status = 'PROCESSED'
							and refund.reference_external_transaction_id = original.external_transaction_id
							and rollback.reference_external_transaction_id = refund.external_transaction_id
							and (refund.wallet_id, refund.player_id, refund.provider_id, refund.currency, refund.round_id, refund.amount)
								= (original.wallet_id, original.player_id, original.provider_id, original.currency, original.round_id, original.amount)
							and (rollback.wallet_id, rollback.player_id, rollback.provider_id, rollback.currency, rollback.round_id, rollback.amount)
								= (refund.wallet_id, refund.player_id, refund.provider_id, refund.currency, refund.round_id, refund.amount)
					) then
						raise exception 'BET already has an active compensation' using errcode = '23514', constraint = 'wager_active_bet_compensation_check';
					end if;
				end if;
				return new;
			end $$;
			create trigger wager_active_bet_compensation before insert or update on wager_transactions
				for each row execute function protect_active_bet_compensation();
			drop index wager_processed_direct_reversal_unique;
		`);
	}

	override down(): void {
		// Refuse newer valid history instead of deleting or reclassifying terminal operations.
		this.addSql(`
			create unique index wager_processed_direct_reversal_unique
				on wager_transactions (reference_transaction_id)
				where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
			drop trigger wager_active_bet_compensation on wager_transactions;
			drop function protect_active_bet_compensation();
		`);
	}
}
