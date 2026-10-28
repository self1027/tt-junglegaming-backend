import { Migration } from '@mikro-orm/migrations';

export class Migration202610280001 extends Migration {
	override up(): void {
		this.addSql(`
create table wallets (
  id uuid primary key default gen_random_uuid(),
  player_id text not null,
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  balance numeric not null,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint wallets_balance_check check (balance >= 0 and balance < 'Infinity'::numeric and scale(balance) = 2),
  constraint wallets_player_currency_unique unique (player_id, currency),
  constraint wallets_context_unique unique (id, player_id, currency),
  constraint wallets_id_currency_unique unique (id, currency)
);

create table wager_transactions (
  id uuid primary key default gen_random_uuid(),
  provider_id text,
  external_transaction_id text,
  idempotency_key text,
  payload_hash text,
  wallet_id uuid not null,
  player_id text not null,
  round_id text,
  game_id text,
  kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  status text not null default 'PENDING' check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  amount numeric not null,
  currency varchar(3) not null,
  reference_external_transaction_id text,
  reference_transaction_id uuid,
  failure_code text,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  processed_at timestamptz,
  constraint wager_amount_check check (amount >= 0 and amount < 'Infinity'::numeric and scale(amount) = 2),
  constraint wager_external_context_check check (kind = 'OPENING' or
    (provider_id is not null and external_transaction_id is not null and
     idempotency_key is not null and payload_hash is not null and round_id is not null and game_id is not null)),
  constraint wager_reference_required_check check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
  constraint wager_pending_reference_check check (status <> 'PENDING_REFERENCE' or
    (reference_external_transaction_id is not null and reference_transaction_id is null)),
  constraint wager_processed_reversal_check check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
  constraint wager_external_identity_unique unique (provider_id, external_transaction_id),
  constraint wager_ledger_context_unique unique (id, wallet_id, currency),
  constraint wager_wallet_fk foreign key (wallet_id, player_id, currency) references wallets (id, player_id, currency) on delete restrict on update restrict,
  constraint wager_reference_fk foreign key (reference_transaction_id) references wager_transactions (id) on delete restrict on update restrict
);
create index wager_wallet_history_idx on wager_transactions (wallet_id, created_at, id);
create index wager_reference_idx on wager_transactions (reference_transaction_id);
create index wager_pending_reference_idx on wager_transactions (next_attempt_at, created_at, id) where status = 'PENDING_REFERENCE';
create unique index wager_processed_reversal_unique on wager_transactions (reference_transaction_id, kind)
  where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');

create table wallet_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null,
  transaction_id uuid not null,
  direction text not null check (direction in ('DEBIT', 'CREDIT')),
  currency varchar(3) not null,
  amount numeric not null,
  balance_before numeric not null,
  balance_after numeric not null,
  created_at timestamptz not null default current_timestamp,
  constraint ledger_amount_check check (amount >= 0 and amount < 'Infinity'::numeric and scale(amount) = 2),
  constraint ledger_before_check check (balance_before >= 0 and balance_before < 'Infinity'::numeric and scale(balance_before) = 2),
  constraint ledger_after_check check (balance_after >= 0 and balance_after < 'Infinity'::numeric and scale(balance_after) = 2),
  constraint ledger_arithmetic_check check (
    (direction = 'CREDIT' and balance_before + amount = balance_after) or
    (direction = 'DEBIT' and balance_before - amount = balance_after)),
  constraint ledger_transaction_wallet_unique unique (transaction_id, wallet_id),
  constraint ledger_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency) on delete restrict on update restrict,
  constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency) references wager_transactions (id, wallet_id, currency) on delete restrict on update restrict
);
create index ledger_wallet_history_idx on wallet_ledger_entries (wallet_id, created_at, id);

create function reject_ledger_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'wallet_ledger_entries is append-only' using errcode = '55000';
end;
$$;
create trigger ledger_append_only before update or delete or truncate on wallet_ledger_entries
  for each statement execute function reject_ledger_mutation();

create table inbox_messages (
  id uuid primary key default gen_random_uuid(),
  consumer_name text not null,
  message_id text not null,
  payload_hash text not null,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSED')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  received_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  processed_at timestamptz,
  constraint inbox_consumer_message_unique unique (consumer_name, message_id),
  constraint inbox_processed_check check ((status = 'PROCESSED') = (processed_at is not null))
);

create table outbox_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  aggregate_id uuid not null,
  event_type text not null,
  event_version integer not null check (event_version >= 1),
  correlation_id text not null,
  causation_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'PENDING' check (status in ('PENDING', 'PUBLISHED')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default current_timestamp,
  next_attempt_at timestamptz not null default current_timestamp,
  published_at timestamptz,
  constraint outbox_event_id_unique unique (event_id),
  constraint outbox_published_check check ((status = 'PUBLISHED') = (published_at is not null))
);
create index outbox_pending_due_idx on outbox_messages (next_attempt_at, created_at, id) where status = 'PENDING';

create function reject_outbox_event_id_change() returns trigger language plpgsql as $$
begin
  if new.event_id is distinct from old.event_id then
    raise exception 'outbox event_id is stable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger outbox_stable_event_id before update on outbox_messages
  for each row execute function reject_outbox_event_id_change();

create table idempotency_records (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  idempotency_key text not null,
  payload_hash text not null,
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'COMPLETED')),
  transaction_id uuid,
  original_result jsonb check (jsonb_typeof(original_result) = 'object'),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint idempotency_scope_key_unique unique (scope, idempotency_key),
  constraint idempotency_result_check check (status <> 'COMPLETED' or
    (transaction_id is not null and original_result is not null)),
  constraint idempotency_transaction_fk foreign key (transaction_id) references wager_transactions (id) on delete restrict on update restrict
);
create index idempotency_transaction_idx on idempotency_records (transaction_id);
`);
	}

	override down(): void {
		// A schema rollback must never become a way to erase confirmed financial history.
		this.addSql(`
do $$ begin
  lock table wallet_ledger_entries in access exclusive mode;
  if exists (select 1 from wallet_ledger_entries) then
    raise exception 'Cannot revert foundation with confirmed ledger entries' using errcode = '55000';
  end if;
end $$;
drop table idempotency_records;
drop table outbox_messages;
drop function reject_outbox_event_id_change();
drop table inbox_messages;
drop table wallet_ledger_entries;
drop function reject_ledger_mutation();
drop table wager_transactions;
drop table wallets;
`);
	}
}
