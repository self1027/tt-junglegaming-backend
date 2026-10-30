import { Migration } from '@mikro-orm/migrations';

export class Migration202610290003 extends Migration {
	override up(): void {
		this.addSql(`
			create function protect_wager_terminal_history() returns trigger language plpgsql as $$
			begin
				if tg_op = 'TRUNCATE' then
					raise exception 'Wager history cannot be truncated' using errcode = '55000';
				end if;
				if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
					if tg_op = 'DELETE' or new is distinct from old then
						raise exception 'Terminal wager history is immutable' using errcode = '55000';
					end if;
				end if;
				if tg_op = 'DELETE' then return old; end if;
				return new;
			end $$;
			create trigger wager_terminal_immutable before update or delete on wager_transactions
				for each row execute function protect_wager_terminal_history();
			create trigger wager_no_truncate before truncate on wager_transactions
				for each statement execute function protect_wager_terminal_history();
		`);
	}

	override down(): void {
		this.addSql(`
			drop trigger wager_no_truncate on wager_transactions;
			drop trigger wager_terminal_immutable on wager_transactions;
			drop function protect_wager_terminal_history();
		`);
	}
}
