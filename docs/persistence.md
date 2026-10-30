# Persistência PostgreSQL e MikroORM

As [migrations](../src/platform/persistence/migrations/) são a fonte das constraints,
FKs, índices parciais e triggers. [Modelos](../src/platform/persistence/models.ts)
são estruturas técnicas declarativas; mappers e repositórios de domínio ficam nos
adapters dos módulos. Decisões e fronteiras estão em [ARCHITECTURE](../ARCHITECTURE.md).

## Representação e schema

PostgreSQL 18.3 está fixado por digest no [Compose](../compose.yaml). Versões do
MikroORM e Bun pertencem ao [package.json](../package.json).
[ExactNumericType](../src/platform/persistence/exact-numeric.type.ts) preserva
strings na ida/volta e no dirty checking, sem conversão monetária para number.

Valores monetários são NUMERIC sem typmod, finitos, não negativos e com
`scale(value) = 2`. CHECK rejeita 1.001, 1, NaN e infinitos, sem arredondar.
Fornecer 1.00. Não há teto comercial; os limites técnicos do PostgreSQL permanecem.
O catálogo ISO e validação lexical de entrada pertencem a [Financial](domain/financial.md#money).
O schema é menos restritivo sobre catálogo, textos/datas e amount zero do ledger;
construção externa passa pelas validações dos adapters/domínio.

Todas as seis tabelas têm id UUID PK com gen_random_uuid(). Datas são TIMESTAMPTZ.
Identidades externas/player/provider/round/game/message são TEXT. JSONB contém
objetos e mantém dinheiro string. Campos com `?` abaixo são nullable.

| Tabela                | Estado e colunas                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wallets               | player_id, currency, balance, version (default 1), created_at, updated_at                                                                                                                                                                                                                                                                                                                   |
| wager_transactions    | provider_id?, external_transaction_id?, idempotency_key?, payload_hash?, wallet_id, player_id, round_id?, game_id?, kind, status (PENDING), amount, currency, reference_external_transaction_id?, reference_transaction_id?, failure_code?, attempts (0), next_attempt_at?, last_attempt_at?, last_error?, created_at, updated_at, processed_at?, claim_token?, claimed_by?, claimed_until? |
| wallet_ledger_entries | wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at                                                                                                                                                                                                                                                                                           |
| inbox_messages        | consumer_name, message_id, payload_hash, status (RECEIVED), attempts (0), last_error?, received_at, updated_at, processed_at?                                                                                                                                                                                                                                                               |
| outbox_messages       | event_id, aggregate_id, event_type, event_version, correlation_id, causation_id?, payload, status (PENDING), attempts (0), last_error?, occurred_at, created_at, next_attempt_at, published_at?, claim_token?, claimed_by?, claimed_until?                                                                                                                                                  |
| idempotency_records   | scope, idempotency_key, payload_hash, status (IN_PROGRESS), transaction_id?, original_result?, created_at, updated_at                                                                                                                                                                                                                                                                       |

Adapters atualizam updated_at explicitamente. Defaults de criação e da data de
agendamento Outbox usam current_timestamp; leases/finalizações usam relógio SQL.
MikroORM registra migrations numa tabela técnica adicional, mikro_orm_migrations.

## Integridade

| Garantia                    | Proteção SQL                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet única e não negativa | wallets_player_currency_unique(player_id,currency), checks de balance/version/moeda                                                     |
| Identidade externa          | wager_external_identity_unique(provider_id,external_transaction_id)                                                                     |
| Contexto da operação        | wager_wallet_fk(wallet_id,player_id,currency) para a wallet; contexto externo obrigatório exceto OPENING                                |
| Referência pendente         | FK nullable; reversões exigem referência externa; PENDING_REFERENCE exige FK nula; reversão PROCESSED exige FK resolvida                |
| Reversão                    | UNIQUE parcial (reference_transaction_id,kind) para REFUND/ROLLBACK PROCESSED e trigger de compensação ativa da BET, conforme Wagering  |
| Ledger                      | UNIQUE(transaction_id,wallet_id), direção DEBIT/CREDIT, equação exata, checks monetários e trigger append-only                          |
| Contexto ledger             | FKs compostas para wallet(id,currency) e transação(id,wallet_id,currency)                                                               |
| Inbox                       | UNIQUE(consumer_name,message_id); PROCESSED equivale a processed_at preenchido                                                          |
| Outbox                      | event_id único; versão positiva, payload objeto; PUBLISHED equivale a published_at preenchido; identidade/envelope/histórico protegidos |
| Idempotência                | UNIQUE(scope,idempotency_key); COMPLETED exige transaction_id e original_result objeto JSONB                                            |
| Claims                      | Trio token/owner/lease todo nulo ou completo; owner não vazio, lease finito; somente estados elegíveis                                  |
| Terminais Wagering          | Trigger recusa UPDATE com alteração ou DELETE de PROCESSED/REJECTED/FAILED e recusa TRUNCATE                                            |

A migration 290004 substitui a unicidade histórica entre modalidades por
`wager_active_bet_compensation_check`. O trigger serializa novas reversões
PROCESSED pela wallet e valida o histórico depois da espera. Só permite a outra
modalidade sobre BET quando um ROLLBACK PROCESSED compatível neutralizou o REFUND
anterior. A unicidade histórica `(reference_transaction_id,kind)` permanece.
Nas demais referências, a exclusão cruzada histórica continua. A wallet da
reversão deve coincidir com a da referência para que todas as disputas usem o
mesmo lock, inclusive em SQL direto. Toda reversão PROCESSED exige referência
PROCESSED; a proteção terminal torna imutável a wallet dessa referência. Isso
fecha a janela anterior à FK em que SQL direto poderia mover uma referência
ainda pendente entre wallets e evitar a coordenação comum.
Violar a compensação ativa produz SQLSTATE 23514 e o nome da proteção; repetir a
modalidade isoladamente produz 23505 / wager_processed_reversal_unique.
O trigger não movimenta saldo nem escreve ledger: esses efeitos continuam na
UnitOfWork. Terminais antigos continuam protegidos pela migration 290003.

FKs são ON DELETE/UPDATE RESTRICT; não há cascata destrutiva. Outbox aggregate_id é
polimórfico e não recebe FK para um único agregado. Não há trigger que imponha a
soma global saldo/ledger ou valide todas as regras de negócio. Atomicidade não
substitui o coordenador: cada BalanceChange precisa de sua transação e lançamento.
Administradores capazes de alterar schema podem remover proteções.

Índices de consulta: wager_wallet_history_idx(wallet_id,created_at,id),
wager_reference_idx(reference_transaction_id), ledger_wallet_history_idx(wallet_id,created_at,id),
idempotency_transaction_idx(transaction_id). Outbox usa outbox_pending_due_idx em
(next_attempt_at,created_at,id) WHERE PENDING. Referências usam wager_pending_due_idx
em (coalesce(next_attempt_at,created_at),created_at,id) para PENDING/PENDING_REFERENCE
com referência externa e kind diferente de OPENING; o índice legado de
PENDING_REFERENCE permanece. Testes EXPLAIN verificam range indexado por
statement_timestamp(), sem tratar clock_timestamp() volátil como limite do índice.

## UnitOfWork e adapters

[MikroOrmUnitOfWork](../src/platform/persistence/mikro-orm-unit-of-work.ts) faz fork
limpo, sem contexto global/herdado, e `transactional(REQUIRES_NEW)`. Execute resolve
após commit e propaga erro original depois de rollback. Sessão é invalidada no
finally; repositórios rejeitam uso posterior. Um execute dentro de outro é outra
transação; colaboradores devem receber o contexto original.

Escrita normal usa READ COMMITTED. `{ readOnly: true }` usa REPEATABLE READ e SET
TRANSACTION READ ONLY para consultas/reconciliação. [Bootstrap](../src/bootstrap/persistence.ts)
compõe wallet, ledger, OPENING, Wagering, idempotência, Inbox e inserção Outbox com
a mesma TransactionSession. Nenhum desses adapters abre commit próprio.

Wallet save exige a instância adquirida por lockById na execução, faz refresh
após FOR UPDATE e condiciona UPDATE à versão lida. Não escreve sem mudança de
versão. Mappers reidratam explicitamente Money/datas/estado sem crédito/débito.
A ordem wallet, transação, ledger atende FKs imediatas. A
[coordenação de negócio](architecture/concurrency.md#coordenação-do-processamento)
acrescenta locks de Inbox/idempotência/identidade antes da wallet.

## Claims e fencing

[OutboxStore](../src/platform/persistence/mikro-orm-outbox-store.ts) e
[PendingWagerStore](../src/modules/wagering/adapters/persistence/mikro-orm-pending.repository.ts)
confirmam seleção FOR UPDATE SKIP LOCKED e UPDATE de token/owner/lease/attempts
numa transação técnica curta. Não mantêm lock enquanto enviam SQS ou esperam wallet.
Next_attempt_at da referência legado NULL usa created_at.

Publisher published/retry são UPDATEs atômicos por eventId, token, PENDING e
claimed_until > clock_timestamp(). Retry grava código sanitizado/agendamento;
publicação grava published_at, preservando envelope. Atualização zero produz
resultado explícito de claim perdido/expirado/estado ausente ou já publicado.

O resolver adquire linha/claim depois da wallet. Finish exige token, estado não
terminal esperado e lease válido; zero updates aborta toda a UnitOfWork financeira.
lockResult/resolvePending também conferem scope/key/hash/transaction_id e
identidades/status anterior do JSON idempotente. Apenas snapshot pendente pode
virar terminal. Retry técnico isolado ocorre após retorno/rollback da UnitOfWork;
commit incerto não reabre terminal.

## Imutabilidade e migrations

| Migration                                                                       | Responsabilidade e down                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [202610280001](../src/platform/persistence/migrations/Migration202610280001.ts) | Fundação de seis tabelas; ledger bloqueia UPDATE/DELETE/TRUNCATE. Down exige ledger vazio, remove estruturas em ordem inversa e recusa apagar histórico confirmado. |
| [202610280002](../src/platform/persistence/migrations/Migration202610280002.ts) | Índice histórico de reversão direta entre tipos, substituído pela 290004; up recusa dados incompatíveis e down remove o índice.                                     |
| [202610290001](../src/platform/persistence/migrations/Migration202610290001.ts) | Claims Outbox; protege id/metadados/envelope/datas e qualquer alteração de PUBLISHED. Down remove novas estruturas, preservando eventos.                            |
| [202610290002](../src/platform/persistence/migrations/Migration202610290002.ts) | Claims/índice de referências; down preserva operações/scheduling e remove reservas técnicas.                                                                        |
| [202610290003](../src/platform/persistence/migrations/Migration202610290003.ts) | Proteção dos terminais Wagering e TRUNCATE; down remove somente triggers/função, sem editar dados.                                                                  |
| [202610290004](../src/platform/persistence/migrations/Migration202610290004.ts) | Guarda de compensação ativa; mantém unicidade por modalidade. Down recusa histórico novo incompatível sem apagar dados.                                             |

O down da 290004 tenta reinstalar o índice histórico antes de remover o trigger.
Se existirem duas modalidades legitimamente PROCESSED para uma BET após
neutralização, falha com 23505 e mantém a migration/guarda atual e todos os dados.
Não apagar nem reclassificar operações para viabilizar esse down. Nesse estado,
um rollback de comportamento exige planejamento explícito; prefira correção
forward. Sem esse histórico novo, down/up preserva registros e ledger.

Up/down são transacionais e all-or-nothing, sem desabilitar FKs. Parar processos
antes de reverter estruturas que eles usam. Com dados financeiros, preferir
migration corretiva forward; down não é remediação de saldo. Sem schema:update,
schema:fresh, sync ou migration automática no startup. Não se garante coordenação
entre múltiplos executores simultâneos de migrations.

## Execução e verificação

[Configuração](../src/platform/persistence/config.ts) exige ambiente validado,
pool min 0/max configurável, conexão com timeout 5s e idle 30s. CLI pertence às
dependências de desenvolvimento; migrations são aplicadas pelo checkout antes da
imagem de produção, que não contém a CLI. [Setup](operations/local-development.md).

[Fundação](../test/persistence.test.ts), [adapters financeiros](../test/financial-persistence.test.ts),
[terminais SQL](../test/wager-history.test.ts), [claims Outbox](../test/publisher-persistence.test.ts)
e [claims de referência](../test/pending-persistence.test.ts) usam PostgreSQL real,
up/status/down/up, violações diretas e rollback. Cenários multiprocesso verificam
locks e reconstrução do saldo. Resultados antigos foram preservados no
[histórico](history/README.md), sem servir como prova da implementação atual.
