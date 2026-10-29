# Fundação PostgreSQL / MikroORM

Decisão e ambiguidades: [ARCHITECTURE.md](../ARCHITECTURE.md#fundação-de-persistência--decisão-aprovada-nesta-tarefa). Requisitos: §§4–6, 7.1, 9–11 e 13 do [enunciado imutável](challenge.md), [Financial](domain/financial.md), [Wagering](domain/wagering.md) e [Messaging](domain/messaging.md).

Entregue: armazenamento, integridade estrutural, [integração financeira transacional](#integração-financeira-e-unitofwork), [processamento atômico da Task 06](#task-06--processamento-atômico) e [inserção Outbox da Task 07](#task-07--outbox-transacional). Os modelos não são entidades de domínio. A Task 09 acrescenta consumer e Inbox transacional; publisher recuperável está entregue na Task 10; worker de referências permanece futuro.

## Versões e execução

- PostgreSQL **18.3**, imagem oficial `postgres:18.3-bookworm` com digest no [Compose](../compose.yaml).
- MikroORM core/driver/migrations/CLI **7.2.5**; integração NestJS **7.1.0**; Bun **1.4.4**; NestJS **11.2.8**.
- [Configuração](../src/platform/persistence/config.ts) recebe ambiente validado, exige credenciais, usa pool min 0/max configurável (10 por padrão), timeout de conexão 5s e timeout ocioso 30s. Sem contexto global, criação automática de banco ou sincronização de schema.
- [Modelos](../src/platform/persistence/models.ts) registrados explicitamente; [`ExactNumericType`](../src/platform/persistence/exact-numeric.type.ts) mantém strings na conversão e na comparação de alterações. Não usa conversão monetária por number.
- Integração oficial Nest cria contexto por requisição e fecha pool no encerramento; o entrypoint já habilita shutdown hooks. Startup exige banco acessível, mas `/health/live` continua verificando apenas o processo HTTP, sem consultar PostgreSQL.

Setup e comandos estão no [README](../README.md). `db:status` mostra migrations executadas e pendentes. `db:migrate` aplica; `db:rollback` reverte a última. CLI executado pelo Bun, instalado somente em desenvolvimento; executar migrations pelo checkout com dependências completas antes de subir a imagem da API. O Dockerfile existente é preservado e não executa migrations no startup.

## Convenções físicas

`id` é UUID PK com default `gen_random_uuid()` em todas as seis tabelas. IDs de player/provider/round/game/message e chaves externas são TEXT, sem impor UUID aos identificadores externos. Todas as datas são TIMESTAMPTZ. `created_at`, `updated_at`, `received_at` e `next_attempt_at` da Outbox têm default `current_timestamp` quando presentes. Adapters informam `updated_at` explicitamente ao alterar registros; não há hook que esconda uma decisão de aplicação.

`money` na tabela abaixo significa **NUMERIC sem typmod**, NOT NULL, finito, não negativo e `scale(value) = 2`. O banco rejeita `1.001`, `1`, NaN e infinitos, sem arredondar; gravar `1.00`. Isso mantém escala exata sem escolher um teto comercial ausente do contrato. O limite técnico permanece o do PostgreSQL. Validação lexical da string também existe no tipo técnico ORM; Money e catálogo ISO-4217 pertencem ao [domínio Financial](domain/financial.md).

Compatibilidade do núcleo financeiro: Money não negativo serializa strings canônicas aceitas por ExactNumericType; seus resultados negativos internos não são persistíveis nessas colunas. Wallet mantém UUID/texto/moeda, saldo não negativo, versão INTEGER e datas; ledger mantém UUIDs, direção e equação compatíveis. O domínio é mais restritivo que os checks SQL: rejeita moeda fora do catálogo, identidades/textos inválidos, datas inconsistentes e lançamento zero, permitido aritmeticamente pelo schema. Isso não exige alterar a migration: todo estado aceito pelo domínio cabe nas representações existentes, sujeito aos limites técnicos do PostgreSQL. Os mappers preservam esse estado, com evidência de atomicidade na integração abaixo.

`?` indica NULL permitido; os demais campos são NOT NULL. Campos opcionais não têm defaults artificiais. `status`, `attempts` e `version` usam os defaults indicados abaixo. JSONB guarda objetos completos; dinheiro dentro de payloads/resultados deve continuar string nos futuros contratos.

| Tabela                  | Colunas físicas além de `id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallets`               | `player_id text`, `currency varchar(3)`, `balance money`, `version integer = 1`, `created_at timestamptz`, `updated_at timestamptz`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wager_transactions`    | `provider_id text?`, `external_transaction_id text?`, `idempotency_key text?`, `payload_hash text?`, `wallet_id uuid`, `player_id text`, `round_id text?`, `game_id text?`, `kind text`, `status text = PENDING`, `amount money`, `currency varchar(3)`, `reference_external_transaction_id text?`, `reference_transaction_id uuid?`, `failure_code text?`, `attempts integer = 0`, `next_attempt_at timestamptz?`, `last_attempt_at timestamptz?`, `last_error text?`, `created_at timestamptz`, `updated_at timestamptz`, `processed_at timestamptz?` |
| `wallet_ledger_entries` | `wallet_id uuid`, `transaction_id uuid`, `direction text`, `currency varchar(3)`, `amount money`, `balance_before money`, `balance_after money`, `created_at timestamptz`                                                                                                                                                                                                                                                                                                                                                                               |
| `inbox_messages`        | `consumer_name text`, `message_id text`, `payload_hash text`, `status text = RECEIVED`, `attempts integer = 0`, `last_error text?`, `received_at timestamptz`, `updated_at timestamptz`, `processed_at timestamptz?`                                                                                                                                                                                                                                                                                                                                    |
| `outbox_messages`       | `event_id uuid`, `aggregate_id uuid`, `event_type text`, `event_version integer`, `correlation_id text`, `causation_id text?`, `payload jsonb`, `status text = PENDING`, `attempts integer = 0`, `last_error text?`, `occurred_at timestamptz`, `created_at timestamptz`, `next_attempt_at timestamptz`, `published_at timestamptz?`, `claim_token uuid?`, `claimed_by text?`, `claimed_until timestamptz?`                                                                                                                                             |
| `idempotency_records`   | `scope text`, `idempotency_key text`, `payload_hash text`, `status text = IN_PROGRESS`, `transaction_id uuid?`, `original_result jsonb?`, `created_at timestamptz`, `updated_at timestamptz`                                                                                                                                                                                                                                                                                                                                                            |

## Constraints e foreign keys

Além das PKs, NOT NULL e checks monetários:

| Tabela             | Integridade protegida pelo PostgreSQL                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wallets            | `wallets_player_currency_unique(player_id,currency)`; `version >= 1`; moeda com três letras A–Z. Uniques auxiliares `(id,player_id,currency)` e `(id,currency)` sustentam FKs compostas.                                                                                                                                                                                                                                                                     |
| Wager transactions | `wager_external_identity_unique(provider_id,external_transaction_id)`; kinds OPENING/BET/WIN/LOSS/REFUND/ROLLBACK; estados PENDING/PENDING_REFERENCE/PROCESSED/REJECTED/FAILED; attempts >= 0. Contexto externo obrigatório exceto OPENING. REFUND/ROLLBACK exigem referência externa; PENDING_REFERENCE exige referência externa e FK interna nula; reversão PROCESSED exige FK resolvida. Unique auxiliar `(id,wallet_id,currency)` sustenta FK do ledger. |
| Ledger             | `ledger_transaction_wallet_unique(transaction_id,wallet_id)`; direction DEBIT/CREDIT; `balance_before ± amount = balance_after`. Trigger `ledger_append_only` bloqueia UPDATE, DELETE e TRUNCATE, inclusive acesso SQL direto.                                                                                                                                                                                                                               |
| Inbox              | `inbox_consumer_message_unique(consumer_name,message_id)`; attempts >= 0; status RECEIVED/PROCESSED e equivalência entre PROCESSED e processed_at preenchido.                                                                                                                                                                                                                                                                                                |
| Outbox             | `outbox_event_id_unique(event_id)`; event_version >= 1, attempts >= 0, payload objeto JSONB; estados PENDING/PUBLISHED e equivalência entre PUBLISHED e published_at preenchido. Trigger `outbox_stable_event_id` bloqueia alteração do event_id, sem bloquear tentativas/publicação.                                                                                                                                                                        |
| Idempotency        | `idempotency_scope_key_unique(scope,idempotency_key)`; estados IN_PROGRESS/COMPLETED; COMPLETED exige transação e original_result objeto JSONB. Resultado é snapshot persistido, independente do saldo atual. Hash e conclusão seguem o contrato Wagering da Task 06.                                                                                                                                                                                        |

Todas as FKs usam `ON DELETE RESTRICT ON UPDATE RESTRICT`, sem cascata destrutiva:

| FK                           | Origem → destino                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `wager_wallet_fk`            | wager_transactions `(wallet_id,player_id,currency)` → wallets `(id,player_id,currency)`                    |
| `wager_reference_fk`         | wager_transactions `reference_transaction_id?` → wager_transactions `id`                                   |
| `ledger_wallet_fk`           | wallet_ledger_entries `(wallet_id,currency)` → wallets `(id,currency)`                                     |
| `ledger_transaction_fk`      | wallet_ledger_entries `(transaction_id,wallet_id,currency)` → wager_transactions `(id,wallet_id,currency)` |
| `idempotency_transaction_fk` | idempotency_records `transaction_id?` → wager_transactions `id`                                            |

Outbox aggregate_id é polimórfico (wallet ou transação), portanto não recebe FK para um único agregado. Inbox não depende de uma única transação de negócio. A referência interna é nullable para permitir desordem real. Os modelos mapeiam relações por PK, sem carregar o grafo de objetos; FKs compostas, checks, índices parciais e triggers têm sua fonte na migration SQL revisada. Gerar um diff automático dos modelos não substitui essa migration.

## Índices de consulta e unicidade condicional

As PKs e constraints UNIQUE acima criam índices B-tree. Índices adicionais:

| Nome                                     | Colunas / predicado                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `wager_wallet_history_idx`               | `(wallet_id,created_at,id)`                                                                           |
| `wager_reference_idx`                    | `(reference_transaction_id)`                                                                          |
| `wager_pending_reference_idx`            | `(next_attempt_at,created_at,id) WHERE status = 'PENDING_REFERENCE'`                                  |
| `wager_processed_reversal_unique`        | UNIQUE `(reference_transaction_id,kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| `wager_processed_direct_reversal_unique` | UNIQUE `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`      |
| `ledger_wallet_history_idx`              | `(wallet_id,created_at,id)`                                                                           |
| `outbox_pending_due_idx`                 | `(next_attempt_at,created_at,id) WHERE status = 'PENDING'`                                            |
| `idempotency_transaction_idx`            | `(transaction_id)`                                                                                    |

A unicidade de reversão protege sucesso por tipo e, desde a Task 06, impede modalidades diretas cumulativas sobre a mesma referência. Tentativas rejeitadas continuam auditáveis. Agendamento de next_attempt_at, leases e limites de tentativas pertencem ao worker futuro.

## Migration e reversão

[`Migration202610280001`](../src/platform/persistence/migrations/Migration202610280001.ts) cria as seis tabelas, constraints, índices e duas funções/triggers. Migrator registra a execução em `mikro_orm_migrations`, uma tabela técnica adicional às seis de aplicação. Up/down são transacionais, all-or-nothing e não desabilitam FKs.

Down adquire lock exclusivo do ledger e recusa a operação se houver qualquer lançamento, preservando histórico confirmado. Em banco descartável sem ledger, remove tabelas e funções em ordem inversa; wallets e outros registros descartáveis são apagados. Não usar down como remediação financeira. Com histórico real, fazer migration corretiva forward; nenhum trigger impede um administrador privilegiado de alterar o schema deliberadamente.

Não usar `schema:update`, `schema:fresh` ou sincronização no deploy. CLI deve rodar uma vez pelo procedimento de release antes da API. Coordenação entre múltiplos executores simultâneos de migrations não faz parte deste estágio.

## Verificação reproduzível

`bun test test/persistence.test.ts` sobe o mesmo Compose em projeto exclusivo, com porta dinâmica, credenciais efêmeras e volume descartável; executa CLI real para up/status/down/up e remove somente seus próprios recursos. Não toca no banco configurado pelo desenvolvedor. Requer Docker Desktop/Engine com Compose, imagem disponível ou acesso ao registry. Sem mocks, SQLite ou skips automáticos quando Docker falta.

Os testes verificam catálogos PostgreSQL e violações por SQL/ORM: seis tabelas, FKs e índices, wallet única, saldo/versão, precisão e dirty checking de centavos acima de 53 bits, identidades externas, OPENING, referências pendentes, reversões por tipo, Inbox/Outbox/idempotência únicas, integridade de contexto, ledger aritmético/imutável, resultado original e eventos recuperáveis por conexão independente. Commit/rollback cobrem múltiplas tabelas; rollback demonstra ausência de efeitos nas seis. Contextos têm identity maps e transações isolados.

O teste de lock mantém `PESSIMISTIC_WRITE` numa wallet e, após confirmar a aquisição, inicia dois processos Bun independentes: NOWAIT na mesma wallet falha com 55P03; outra wallet adquire lock. Após commit, a primeira também fica disponível. PIDs e resultados aparecem na saída. Não há sleep para fabricar concorrência, lock global ou teste de apostas implementado artificialmente.

`bun test test/api.test.ts` usa outro container isolado e comprova inicialização Nest, HTTP liveness real e fechamento do pool. A suíte normal `bun run test` inclui esses testes e os testes negativos de arquitetura, inclusive rejeição de imports ORM em domínio/aplicação.

Pendências atuais: backoff/TTL, claims de referências e atualização condicionada de resultados pendentes pelo worker. Publicação concorrente e recuperação estão entregues na Task 10. Inbox e crash/ACK estão cobertos na Task 09. As evidências históricas dos adapters abaixo não substituem as do processador completo nas Tasks 06 e 07.

## Task 10 — aquisição e confirmação da Outbox

[Migration202610290001](../src/platform/persistence/migrations/Migration202610290001.ts)
acrescenta claim_token UUID, claimed_by texto e claimed_until timestamptz, todos
null por default. CHECK exige ausência conjunta ou trio completo com owner não
vazio, expiração finita e estado PENDING. Legados PENDING/PUBLISHED continuam
válidos. Trigger adicional protege id/metadados/envelope/ocorrência/criação e
impede qualquer mudança em PUBLISHED. O trigger original de event_id permanece.
Down remove somente novos campos/constraint/trigger; preserva eventos e histórico,
mas perde reservas técnicas, portanto exige parar publishers antes da reversão.
Migrations históricas não foram editadas. Prefira correção forward em produção.

[OutboxStore](../src/platform/messaging/outbox.ts) é porta técnica independente
com claim/published/retry/diagnostics. O [adapter](../src/platform/persistence/mikro-orm-outbox-store.ts)
usando MikroORM fica em Platform, sem imports de negócio. Ele abre uma transação
**técnica** curta por aquisição; não usa nem prolonga TransactionSession financeira.
CTE SELECT FOR UPDATE SKIP LOCKED seleciona PENDING/due/sem lease válido e UPDATE
reserva lote/token novo por linha, incrementando attempts. Commit antecede SQS.
Predicado next_attempt_at <= statement_timestamp() fornece Index Cond no índice
parcial existente `(next_attempt_at, created_at, id)`; relógio volátil não é usado
como limite de range. Ordem da seleção é agendamento/criação/ID, sem representar
ordem de commit financeiro ou impor ordem de envio.

published/retry são UPDATEs atômicos fora da transação financeira, com eventId,
token, PENDING e claimed_until > clock_timestamp(). SQL decide tempo de lease;
dono antigo não confirma/reagenda/libera claim novo. Atualização zero consulta
estado e devolve diagnóstico explícito. Confirmação preenche published_at, limpa
claim/last_error e preserva fato. Retry escreve next_attempt_at/last_error sanitizado
e limpa somente claim válido. Falha SQL deixa lease recuperável. attempts conta
claims confirmados, sem incremento em consultas. Sem DELETE ou estado terminal.
[Contrato e política](domain/messaging.md#task-10--publicação-recuperável).

Testes reais: [persistência/EXPLAIN/migrations](../test/publisher-persistence.test.ts),
[três processos](../test/publisher-pipeline.test.ts) e [falhas SQL/SQS](../test/publisher-recovery.test.ts),
[Docker/SIGTERM](../test/publisher-docker.test.ts). Não alteram wallet, ledger,
idempotência ou Inbox. Fonte de resultados: [relatório](task10-outbox-report.md).

## Task 09 — Inbox transacional

[Porta](../src/modules/wagering/public/inbox.ts) e
[adapter](../src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts)
reutilizam inbox_messages e suas constraints existentes; nenhuma migration nova.
Bootstrap compõe com a mesma sessão de wallet/ledger/Wagering/idempotência/Outbox.
Claim SQL vem antes dos locks de negócio; não há commit próprio, lease ou segunda
UnitOfWork. [Identidade/hash, estados, tentativas e ACK](domain/messaging.md#task-09--protocolo-de-recepção-implementado).

Asserções reais em [Inbox](../test/inbox.test.ts) e
[SQS/consumer](../test/sqs-consumer.test.ts): commit conjunto, rollback de todos
os participantes ao falhar conclusão, claims concorrentes, conflito de hash,
redelivery/crash antes/depois do commit, duplicatas de negócio entre transportes.
O consumer configura statement_timeout e transaction_timeout no PostgreSQL via
conexão, sem mudar limites da API; o harness consulta os settings efetivos.
O prazo externo de shutdown pode terminar primeiro: desconexão libera/reverte
transação não confirmada e a mensagem permanece recuperável. [Relatório](task09-sqs-report.md).

## Task 07 — Outbox transacional

[MikroOrmOutboxRepository](../src/modules/wagering/adapters/persistence/mikro-orm-outbox.repository.ts)
insere eventos validados usando a mesma TransactionSession do contexto Wagering,
composto em bootstrap. Reutiliza `outbox_messages`, UNIQUE de event_id, CHECKs,
trigger de identidade e índice parcial existentes; nenhuma migration nova nem
alteração nas migrations anteriores.

O JSONB contém o envelope inteiro, com `version` correspondente a `event_version`.
Status PENDING, attempts 0, created_at e next_attempt_at usam defaults SQL;
last_error/published_at permanecem nulos. occurred_at vem do fato de negócio.
aggregate_id é transactionId ou walletId conforme o [protocolo](domain/messaging.md#task-07--protocolo-v1-implementado).

ProcessWagerUseCase insere eventos após Wagering/wallet/ledger e antes do resultado
idempotente. Falha em qualquer participante reverte todas as inserções/atualizações.
O adapter não faz commit/flush, transação própria, update, retry, claim ou publicação.
Portas encerradas rejeitam uso inclusive depois de falha; eventos não são recriados
em replay. Não há lock global acrescentado.

Testes reais e inventário em [relatório da Task 07](task07-outbox-report.md):
falha no segundo INSERT da Outbox, erro SQL posterior em idempotência, eventId
duplicado, precisão acima de 53 bits, nova conexão/processo após commit, três
processos/50 duplicatas e crash antes/depois do commit. Os cenários financeiros
reconciliam saldo e ledger e verificam ausência de eventos órfãos pelo walletId
do payload, inclusive quando a transação de negócio não persistiu.

## Task 06 — processamento atômico

Contrato e políticas são definidos em [Wagering](domain/wagering.md#task-06--políticas-e-contrato-aprovados), sem duplicar aqui regras financeiras. `ProcessWagerUseCase` usa uma única execução do contexto estendido. `MikroOrmIdempotencyRepository` e `MikroOrmWagerTransactionRepository` recebem a mesma TransactionSession dos adapters Financial. Não abrem transação nem fazem commit próprios. Mappers explicitam nulabilidade, Money decimal e reidratação dos cinco estados; metadados de retry ficam fora do domínio. `insertProcessed` permanece compatível.

Ordem de recursos: claim scope/key (INSERT ON CONFLICT e leitura FOR UPDATE quando existente) → advisory transaction lock da tupla de identidade externa → resolução player/moeda e wallet FOR UPDATE → referência/histórico → Wagering → wallet/ledger quando mudam → idempotency COMPLETED → commit. Replay retorna snapshot JSONB sem adquirir wallet nem gravar efeitos. Hash divergente e identidade externa com outra key são erros de aplicação; a reserva desta tentativa é revertida. Nenhuma key confirmada pendente permanece IN_PROGRESS.

`PENDING_REFERENCE` representa ausência, FK nula. Referência existente ainda em processamento mantém a operação em PENDING; resultado JSONB guarda motivo NOT_PROCESSED e ID/status observado. Replays pendentes não reavaliam a referência. Futuro worker deverá localizar ambos os estados, adquirir a coordenação descrita e atualizar atomicamente somente resultado não terminal; essa porta/worker não foi antecipada. `save` não sobrescreve estados terminais e não reseta metadados técnicos.

### Migration adicional

[Migration202610280002](../src/platform/persistence/migrations/Migration202610280002.ts) adiciona `wager_processed_direct_reversal_unique(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`. O índice anterior por modalidade permanece. Rejeições não participam do predicado; ROLLBACK de REFUND tem outro ID referenciado. Up falha sobre histórico cumulativo incompatível sem excluir registros; down remove somente o índice, preservando histórico. Rollback integral da fundação continua recusando ledger confirmado; testes usam `--to 0` para verificar essa proteção com as duas migrations.

### Evidências executáveis

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.1, PostgreSQL 18.3 real em projetos/volumes descartáveis. Harness existente em [support/postgres.ts](../test/support/postgres.ts), filhos independentes em [wager-process.ts](../test/support/wager-process.ts) com pools próprios de duas conexões. stdin fornece barreiras bufferizadas; sinais JSON registram PIDs. `pg_stat_activity.wait_event_type = 'Lock'` confirma contenção antes da liberação; polling limitado a 5s, sinais com deadline de 10s. Sem sleeps usados como prova de corrida.

- [Unidade](../test/process-wager.test.ts): cinco operações, zero, reversões e cadeias, insuficiências distintas, referências ausente/em processamento/terminal/incompatível, replay histórico, conflitos e propagação de falhas técnicas.
- [Portas SQL](../test/wagering-persistence.test.ts): cinco estados e precisão acima de 53 bits; reserva/conclusão/rollback; up/down/up do índice com histórico preservado; violação direta da unicidade cruzada; atualização não terminal e recusa de reabertura.
- [Processador SQL](../test/process-wager-persistence.test.ts): commits completos BET/WIN/LOSS; rejeições/pendências sem efeitos; rollback em falhas SQL de Wagering, wallet, ledger e conclusão idempotente, seguido de retry seguro; replay histórico; conflitos e independência de providers; inversas e cadeias; estados de referência; insuficiência de reversão.
- Três processos disputando a mesma wallet: três BETs resultam em 70.00, versão 4, três débitos mais OPENING. Wallets distintas confirmam enquanto a terceira mantém lock. Rollback do detentor seguido de duas BETs de 80.00/100.00 resulta em uma PROCESSED, uma REJECTED, saldo 20.00, versão 2 e um débito de 80.00.
- Mesma key em três processos e 50 submissões distribuídas em três pools: um débito/uma transação/um registro idempotente; 49 replays no lote. Outra key para a mesma identidade externa produz conflito sem nova operação. REFUND/ROLLBACK concorrentes e mesma modalidade duplicada produzem uma única reversão. Original e reversão concorrentes concluem sem inversão de locks nos cenários executados.
- Processo encerrado antes de commit, com concorrentes comprovadamente esperando SQL: reserva, wallet, ledger e wager são revertidos; outro processo aplica uma vez e o restante faz replay. Processo encerrado após commit e antes de entregar resposta: ambos os concorrentes retornam replay, preservando saldo original. Não há ACK/publicação nessa prova.
- Ordem inversa: reversão adquire wallet antes da original e confirma PENDING_REFERENCE; a original que aguardava o lock confirma depois. Replay da reversão preserva a resposta pendente original sem executar um worker implícito ou gerar crédito.
- Em todos os cenários financeiros, reconciliação pelo ledger confere saldo, versão, contagens, valores/direção dos lançamentos e estados/idempotência. Regressão de Unicode confirma que surrogate inválido não pode selecionar a wallet de U+FFFD.

Revisão independente identificou colapso de identidades Unicode pelo driver UTF-8. Regressões foram observadas falhando antes da correção; aplicação agora rejeita surrogates isolados em todos os textos antes do hash/SQL e preserva Unicode válido. Revisor confirmou a correção em unidade e PostgreSQL; nenhum outro defeito acionável encontrado.

Validação final em 2026-10-28:

| Comando / verificação                  | Resultado                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                    | Passou                                                                                                                        |
| `bun run lint`                         | Passou; arquitetura sem violações, 45 módulos e 131 dependências                                                              |
| `bun run format:check`                 | Passou                                                                                                                        |
| `bun run test`                         | **248 passaram, 0 falharam, 1772 asserções, 12 arquivos**, incluindo 21 testes de arquitetura positivos/negativos             |
| Novas suítes da Task 06                | 33 testes isolados, 4 de portas SQL e 32 de processamento SQL/distribuído                                                     |
| `bun run build`                        | Passou                                                                                                                        |
| Documentação e integridade do checkout | Links relativos conferidos; `git diff --check` passou; enunciado, migration inicial, dependências e regras strict preservados |

PIDs da execução final, registrados pelos filhos e correlacionados às esperas SQL:

| Cenário               | Processos e resultado                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| 50 duplicatas         | 3348 segurou commit (1 aplicação/16 replays); 2672 esperou e fez 17 replays; 30504 esperou e fez 16 replays |
| Rollback e 100/80/80  | 27392 reverteu; 29900 confirmou 80.00; 14492 rejeitou por insuficiência; saldo 20.00/versão 2               |
| Crash antes do commit | 29704 encerrado no sinal before-commit; 3256 aplicou; 5456 fez replay                                       |
| Crash após commit     | 13596 encerrado no sinal committed-before-response; 30432 e 30364 fizeram replay                            |

Todos os containers/volumes descartáveis da validação foram encerrados/removidos pelo harness. Nenhuma imagem da aplicação foi reconstruída; build TypeScript e inicialização Nest/HTTP real passaram na suíte. Não foram executados SQS/LocalStack ou testes de publicação, que não pertencem a esta etapa.

Durante a Task 06, Graphify estava indisponível: consultas com símbolos reais falharam com `command not found: graphify` mesmo após incluir `.local/bin` no PATH. Naquela execução o índice não foi atualizado e a exploração usou busca restrita. A [recuperação posterior autorizada](tooling/graphify.md#recuperação-verificada--2026-10-28) instalou o CLI e validou construção, query, explain e path; não altera retroativamente as evidências da Task 06.

### Arquivos da Task 06

Criados: `src/modules/wagering/application/canonical-wager.ts`, `src/modules/wagering/application/process-wager.use-case.ts`, `src/modules/wagering/public/process-wager.ts`, `src/modules/wagering/adapters/persistence/mappers.ts`, `src/modules/wagering/adapters/persistence/mikro-orm-idempotency.repository.ts`, `src/bootstrap/wagering.ts`, `src/platform/persistence/migrations/Migration202610280002.ts`; três suítes `test/process-wager.test.ts`, `test/wagering-persistence.test.ts`, `test/process-wager-persistence.test.ts`; dois helpers `test/support/wager-child.ts`, `test/support/wager-process.ts`; [plano de checkpoints](superpowers/plans/2026-10-28-process-wager.md).

Evoluídos: porta `src/modules/wagering/public/persistence.ts`, exports `public/index.ts`, adapter Wagering existente, composição `src/bootstrap/persistence.ts`, registro de migrations `src/platform/persistence/config.ts`, expectativas de integridade em `test/persistence.test.ts`; este documento, Wagering, referências de Financial, requisitos, arquitetura e README. Domínio Wagering e seus testes preexistentes foram preservados. Nenhuma alteração em dependências, configuração strict, migration inicial ou enunciado.

Limites: nenhuma garantia de entrega exactly-once; sem publicação, ACK, SQS, retry automático, TTL, worker, endpoints ou classificação genérica em FAILED. Testes demonstram os cenários descritos, não ausência universal de deadlocks sob quaisquer clientes SQL que ignorem a ordem contratada.

## Integração financeira e UnitOfWork

Histórico da tarefa Financial Persistence Integration & Transactional UnitOfWork: entregou a base de §§5, 6.0–6.4, 8–9 e 13 sem antecipar ProcessWagerUseCase. A Task 06 acima evolui as portas e acrescenta uma migration; a integração Financial permanece preservada.

| Contrato / implementação                                                                                                                   | Responsabilidade                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Financial persistence](../src/modules/financial/public/persistence.ts)                                                                    | `WalletRepository` busca por ID/player+moeda, lock, inserção e atualização; `WalletLedgerRepository` append/leitura ordenada; `OpeningTransactionRepository` registro interno de abertura; `FinancialTransactionContext` e `UnitOfWork` |
| [Wagering persistence](../src/modules/wagering/public/persistence.ts)                                                                      | Inserção técnica mínima `insertProcessed(ProcessedWagerRecord)` e extensão do contexto; não é a entidade WagerTransaction nem seu processamento                                                                                         |
| [Mappers](../src/modules/financial/adapters/persistence/mappers.ts)                                                                        | WalletRow ↔ Wallet, WalletLedgerEntryRow ↔ WalletLedgerEntry; NUMERIC string ↔ Money, UUIDs, versão e datas preservados, sem transições                                                                                                 |
| [Wallet adapter](../src/modules/financial/adapters/persistence/mikro-orm-wallet.repository.ts)                                             | Lock PostgreSQL por linha, refresh após lock e atualização condicionada à versão                                                                                                                                                        |
| [Ledger adapter](../src/modules/financial/adapters/persistence/mikro-orm-ledger.repository.ts)                                             | INSERT append-only e ordenação crescente `(created_at,id)` conforme índice existente                                                                                                                                                    |
| [OPENING adapter](../src/modules/financial/adapters/persistence/mikro-orm-opening.repository.ts)                                           | Registro interno PROCESSED na tabela compartilhada, sem dependência Financial → Wagering                                                                                                                                                |
| [Wagering adapter](../src/modules/wagering/adapters/persistence/mikro-orm-wager-transaction.repository.ts)                                 | INSERT do registro processado com contexto externo e referência fornecidos pelo coordenador                                                                                                                                             |
| [UnitOfWork técnico](../src/platform/persistence/mikro-orm-unit-of-work.ts) / [sessão](../src/platform/persistence/transaction-session.ts) | Fork e transação por execução, commit/rollback, invalidação do contexto; Platform não importa módulos                                                                                                                                   |
| [Composição](../src/bootstrap/persistence.ts)                                                                                              | Instancia os adapters com a mesma sessão; ApiModule disponibiliza `UNIT_OF_WORK`                                                                                                                                                        |

`execute<T>(work: (context) => Promise<T>): Promise<T>` abre uma transação READ COMMITTED, entrega o contexto e só resolve após commit. Rejeição do callback ou erro SQL não tratado causa rollback e propaga o erro original. Colaboradores devem receber o contexto e aguardar todas as operações; uma nova chamada a `execute` é outra transação, inclusive dentro de um callback. Não compartilhar instâncias de domínio entre execuções, usar repositórios depois do callback ou capturar falha SQL para continuar uma transação abortada. Não há retries automáticos. Comportamento transacional segue a [API oficial MikroORM](https://mikro-orm.io/docs/transactions), exercitada na versão instalada.

As escritas são parametrizadas pelo ORM, executadas imediatamente no EntityManager transacional. Nenhum repositório do contexto financeiro abre transação ou faz commit/flush independente. Uma falha de FK/UNIQUE/CHECK mantém código PostgreSQL reconhecível pelo chamador. O contexto atual contém idempotência, Wagering, Outbox e Inbox opcional, todos vinculados à mesma TransactionSession.

Ordem de criação: **wallet → transação financeira → ledger**, por causa das FKs imediatas. Em wallet existente, adquirir lock antes de qualquer cálculo sobre saldo; atualizar wallet e inserir a transação antes de inserir o ledger. Erro posterior reverte todos os efeitos. Os testes também escrevem transação/ledger antes de uma atualização que falha, para comprovar rollback dessa ordem. UnitOfWork garante a fronteira atômica, não exige efeitos de negócio: cabe ao futuro coordenador associar cada BalanceChange ao registro e ledger corretos.

`lockById` usa PESSIMISTIC_WRITE (`FOR UPDATE`), espera o detentor e mantém lock até commit/rollback. A wallet é reconstruída com refresh após aquisição, evitando identity map obsoleto. Para várias wallets, adquirir sequencialmente em **ordem crescente dos UUIDs canônicos em minúsculas**, independentemente da ordem de entrada. Não há mutex global ou lock em memória como garantia. O mapa local apenas associa a instância devolvida ao lock já obtido no banco. Ausência de registro retorna undefined; criação concorrente continua protegida pela UNIQUE de player/moeda, sem presumir lock de registro inexistente.

`insert` nunca atualiza uma wallet existente. `save` exige exatamente a instância retornada pelo lock naquela execução; leituras simples e objetos de outro contexto não podem sobrescrever saldo. O UPDATE condiciona ID e versão observada sob lock, exigindo uma linha alterada: **versão é proteção adicional e rastreabilidade**, enquanto o lock serializa o cálculo financeiro. A versão vem do domínio; o ORM não a incrementa. Sem mudança, save não executa UPDATE nem altera timestamps. Isso permite leitura/replay sem efeitos; replay de wagering ainda não existe.

A [proposta registrada antes da implementação](financial-persistence-proposal.md) adicionou `Wallet.open` sem alterar `create` ou `rehydrate`; detalhes pertencem a [Financial](domain/financial.md#abertura-9). Abertura positiva é testada com OPENING legítima e ledger, versão 1; abertura zero não gera registro financeiro. A Task 08 entrega o caso de uso e endpoint sobre essas mesmas portas.

## Task 08 — abertura, consultas e snapshot

CreateWalletUseCase usa uma execução transacional para wallet/OPENING/ledger, com versão 1. Falhas em OPENING ou ledger revertem toda a criação. O adapter mantém o erro PostgreSQL original; o filtro HTTP só converte 23505 de wallets_player_currency_unique em conflito de abertura. Erros de unicidade de outras estruturas não viram esse conflito.

UnitOfWork.execute recebe opção localizada `{ readOnly: true }`: fork sem contexto transacional herdado, isolamento REPEATABLE READ e SET TRANSACTION READ ONLY antes da primeira leitura. ReconcileWalletUseCase e consultas usam essa execução. PostgreSQL impede INSERT nesse modo; snapshot é mantido entre leitura da wallet e do ledger, sem bloqueio exclusivo. Contexto continua invalidado ao sair; processamento normal preserva READ COMMITTED e a ordem de locks da Task 06. Nenhuma migration foi necessária, e nenhuma garantia do schema foi relaxada.

Ledger paginado aplica limite/keyset no banco por `(created_at,id)`, usando a linha âncora para recuperar o timestamp completo. Não converte timestamp SQL para Date antes de comparar o cursor; empates e microssegundos são cobertos por fixture explícita. DTOs excluem entidades/mapeamentos técnicos. Cada página tem snapshot próprio; não se promete um único snapshot entre requisições de paginação. Reconciliação lê todo o histórico no mesmo snapshot e não escreve.

Validação em [HTTP real](../test/http-api.test.ts) e [três processos API](../test/http-concurrency.test.ts): opening zero/positivo/grande, rollback em OPENING/ledger, criação concorrente, 100/80/80, 50 duplicatas, wallets independentes, snapshot durante commit, resposta perdida após commit e falha no segundo evento Outbox. O teste de pool saturado classifica timeout transitório como 503 sem comprometer liveness. [Contrato HTTP](http-api.md) e [relatório](task08-http-report.md).

### Evidências da integração — 2026-10-28

`bun test test/financial-persistence.test.ts` usa PostgreSQL 18.3 do mesmo Compose, em projeto/volume exclusivo com teardown, sem mocks/SQLite. [Fixtures](../test/support/financial.ts) compõem primitivas e portas reais somente para testes; não implementam antecipadamente um use case de produção.

- Precisão acima de 53 bits com alteração de centavos, reidratação de Money/Wallet/ledger, IDs, timestamps em milissegundos e versões; ledger ordenado também com empate de data.
- Commit de abertura positiva; zero sem OPENING/ledger; rollback de wallet/transação após FK inválida no ledger e de toda abertura após duplicata; falha SQL injetada por trigger descartável no UPDATE reverte transação/ledger já escritos.
- Constraints propagadas com 23503/23505/23514, callback com erro original preservado, ausência de escrita sem lock, releitura fresca sob lock, contextos independentes e uso recusado após sucesso/falha.
- Pool limitado a duas conexões executa mais sucessos/rollbacks que a capacidade, sem esgotamento nem sessões idle in transaction; fechamento explícito em todos os caminhos.
- [Três processos Bun](../test/support/financial-process.ts), com conexões e pools próprios, coordenados por sinais e confirmação de espera em pg_stat_activity: três créditos de 0.01 resultam em 100.03, versão 4 e quatro lançamentos contando OPENING. Sem lost updates.
- Duas wallets confirmam operações enquanto uma terceira permanece bloqueada por outro processo. Após rollback de um detentor, dois débitos concorrentes de 80.00 sobre 100.00 produzem um sucesso, um erro de saldo insuficiente, saldo 20.00, versão 2 e um débito. Ledger reconciliado em todos esses cenários.
- Timeout de aquisição configurado apenas no processo de teste propaga 55P03, sem retry nem efeitos financeiros. PIDs/resultados aparecem na saída; os filhos encerram o ORM e o harness verifica saída bem-sucedida.

Os débitos concorrentes exercitam as primitivas financeiras e adapters; não persistem uma rejeição Wagering nem implementam replay. Não se declara aceitação distribuída completa: duplicatas idempotentes, Inbox/Outbox, SQS, crash/ACK e workers permanecem futuros. Os testes negativos de arquitetura seguem cobrindo independência do domínio/aplicação e proibição de Financial → Wagering.

Validação desta integração em Windows/PowerShell, Bun 1.4.4 e Docker Engine 29.8.0, PostgreSQL 18.3:

| Comando                         | Resultado                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bun run typecheck`             | Passou                                                                                            |
| `bun run lint`                  | Passou; 34 módulos e 82 dependências, sem violações                                               |
| `bun run format:check`          | Passou                                                                                            |
| `bun run test`                  | **124 passaram, 0 falharam**, 841 asserções, 8 arquivos; 16 testes novos de integração financeira |
| `bun run build`                 | Passou                                                                                            |
| Migrations, via suíte existente | Up/status/down/up e recusa de down com ledger confirmado passaram em banco descartável            |

Na execução completa, créditos na mesma wallet usaram PIDs 5332/18564/8376; wallets distintas, 2788/8544/2448; rollback seguido de disputa de saldo, 8380/8388/15356; timeout 55P03, 15220/4148. Os sinais e a consulta pg_stat_activity confirmaram a contenção antes de liberar o detentor. Ledger reconciliado após commit/rollback; pools e recursos descartáveis encerrados pelo harness. Nenhuma imagem Docker da aplicação foi reconstruída nesta integração; o build TypeScript e a inicialização Nest real passaram.

## Histórico de evidências da fundação — 2026-10-28

Ambiente: Windows/PowerShell com Bun 1.4.4, Docker Desktop (Engine 29.8.0), containers Linux amd64. `select version()` confirmou PostgreSQL 18.3 (Debian 18.3-1.pgdg12+1). Dependências instaladas por `bun add --exact`, com lockfile; a instalação congelada também passou nos estágios de desenvolvimento e produção do Dockerfile.

| Comando / cenário executado                               | Resultado real                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                                       | Passou                                                                                                                                            |
| `bun run lint`                                            | Passou sem warnings; Dependency Cruiser sem violações                                                                                             |
| `bun run format:check`                                    | Passou                                                                                                                                            |
| `bun run test`                                            | **49 passaram, 0 falharam**, 151 asserções, 4 arquivos; 24 testes de persistência, 2 de configuração/tipo monetário, 2 da API e 21 de arquitetura |
| `bun run build`                                           | Passou, JavaScript emitido em dist                                                                                                                |
| `db:migrate` / `db:status` / `db:rollback` / `db:migrate` | Executados pelo harness contra banco descartável; up/down/up passou, dados descartáveis removidos, nenhuma migration pendente                     |
| Down com ledger confirmado                                | Recusado; lançamento preservado e migration permaneceu aplicada                                                                                   |
| Locks entre processos                                     | Holder PID 17272; mesma wallet PID 4296 recebeu 55P03; outra wallet PID 17008 adquiriu lock; após commit, a primeira ficou disponível             |
| `docker build -t dwp-persistence-check .`                 | Passou com o Dockerfile existente                                                                                                                 |
| API da imagem + PostgreSQL migrado                        | Inicialização real, GET /health/live = 200 e `{"status":"ok"}`; encerrada com SIGTERM                                                             |
| Documentação / diff                                       | Links relativos e âncoras conferidos; `git diff --check` passou; enunciado e configurações ESLint/Dependency Cruiser preservados                  |

Graphify consultado antes da exploração (`createApi ApiModule`, configuração arquitetural), atualizado após mudanças e reconfirmado por `persistenceConfig ExactNumericType WalletRow` e caminho `ApiModule → persistenceConfig`. Os arquivos de configuração CLI e de lock contêm apenas código no topo, sem símbolos próprios extraídos; seus imports foram conferidos diretamente. O índice permanece derivado, não uma prova de integridade.

Todos os recursos Compose da validação foram removidos, incluindo volumes descartáveis; a imagem de teste ficou disponível localmente. Nenhum check solicitado foi omitido. Casos de uso financeiros, SQS e workers continuam fora desta entrega.

## Inventário de arquivos

Criados:

- [compose.yaml](../compose.yaml) e este [docs/persistence.md](persistence.md).
- [config.ts](../src/platform/persistence/config.ts), [mikro-orm.config.ts](../src/platform/persistence/mikro-orm.config.ts), [models.ts](../src/platform/persistence/models.ts), [exact-numeric.type.ts](../src/platform/persistence/exact-numeric.type.ts) e [Migration202610280001.ts](../src/platform/persistence/migrations/Migration202610280001.ts).
- [persistence.test.ts](../test/persistence.test.ts), [persistence-config.test.ts](../test/persistence-config.test.ts), [support/postgres.ts](../test/support/postgres.ts) e [support/wallet-lock.ts](../test/support/wallet-lock.ts).

Modificados:

- [.env.example](../.env.example), [package.json](../package.json), [bun.lock](../bun.lock) e [api.module.ts](../src/bootstrap/api.module.ts).
- [api.test.ts](../test/api.test.ts) e [architecture.test.ts](../test/architecture.test.ts).
- [ARCHITECTURE.md](../ARCHITECTURE.md), [README.md](../README.md), [docs/requirements.md](requirements.md), [docs/domain/financial.md](domain/financial.md), [AGENTS.md](../AGENTS.md) e [Persistence AGENTS.md](../src/platform/persistence/AGENTS.md).
