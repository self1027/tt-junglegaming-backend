# Fundação PostgreSQL / MikroORM

Decisão e ambiguidades: [ARCHITECTURE.md](../ARCHITECTURE.md#fundação-de-persistência--decisão-aprovada-nesta-tarefa). Requisitos: §§4–6, 7.1, 9–11 e 13 do [enunciado imutável](challenge.md), [Financial](domain/financial.md), [Wagering](domain/wagering.md) e [Messaging](domain/messaging.md).

Entregue: armazenamento e integridade estrutural. Os modelos não são entidades de domínio. Não há processamento financeiro, repositórios de aplicação, UnitOfWork definitivo, consumer, publisher ou algoritmo de idempotência.

## Versões e execução

- PostgreSQL **18.3**, imagem oficial `postgres:18.3-bookworm` com digest no [Compose](../compose.yaml).
- MikroORM core/driver/migrations/CLI **7.2.5**; integração NestJS **7.1.0**; Bun **1.4.4**; NestJS **11.2.8**.
- [Configuração](../src/platform/persistence/config.ts) recebe ambiente validado, exige credenciais, usa pool min 0/max configurável (10 por padrão), timeout de conexão 5s e timeout ocioso 30s. Sem contexto global, criação automática de banco ou sincronização de schema.
- [Modelos](../src/platform/persistence/models.ts) registrados explicitamente; [`ExactNumericType`](../src/platform/persistence/exact-numeric.type.ts) mantém strings na conversão e na comparação de alterações. Não usa conversão monetária por number.
- Integração oficial Nest cria contexto por requisição e fecha pool no encerramento; o entrypoint já habilita shutdown hooks. Startup exige banco acessível, mas `/health/live` continua verificando apenas o processo HTTP, sem consultar PostgreSQL.

Setup e comandos estão no [README](../README.md). `db:status` mostra migrations executadas e pendentes. `db:migrate` aplica; `db:rollback` reverte a última. CLI executado pelo Bun, instalado somente em desenvolvimento; executar migrations pelo checkout com dependências completas antes de subir a imagem da API. O Dockerfile existente é preservado e não executa migrations no startup.

## Convenções físicas

`id` é UUID PK com default `gen_random_uuid()` em todas as seis tabelas. IDs de player/provider/round/game/message e chaves externas são TEXT, sem impor UUID aos identificadores externos. Todas as datas são TIMESTAMPTZ. `created_at`, `updated_at`, `received_at` e `next_attempt_at` da Outbox têm default `current_timestamp` quando presentes. `updated_at` deve ser informado pelo futuro adapter ao alterar o registro; não há hook que esconda uma decisão de aplicação.

`money` na tabela abaixo significa **NUMERIC sem typmod**, NOT NULL, finito, não negativo e `scale(value) = 2`. O banco rejeita `1.001`, `1`, NaN e infinitos, sem arredondar; gravar `1.00`. Isso mantém escala exata sem escolher um teto comercial ausente do contrato. O limite técnico permanece o do PostgreSQL. Validação lexical da string também existe no tipo técnico ORM; catálogo ISO-4217 e Money do domínio continuam pendentes.

`?` indica NULL permitido; os demais campos são NOT NULL. Campos opcionais não têm defaults artificiais. `status`, `attempts` e `version` usam os defaults indicados abaixo. JSONB guarda objetos completos; dinheiro dentro de payloads/resultados deve continuar string nos futuros contratos.

| Tabela                  | Colunas físicas além de `id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallets`               | `player_id text`, `currency varchar(3)`, `balance money`, `version integer = 1`, `created_at timestamptz`, `updated_at timestamptz`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wager_transactions`    | `provider_id text?`, `external_transaction_id text?`, `idempotency_key text?`, `payload_hash text?`, `wallet_id uuid`, `player_id text`, `round_id text?`, `game_id text?`, `kind text`, `status text = PENDING`, `amount money`, `currency varchar(3)`, `reference_external_transaction_id text?`, `reference_transaction_id uuid?`, `failure_code text?`, `attempts integer = 0`, `next_attempt_at timestamptz?`, `last_attempt_at timestamptz?`, `last_error text?`, `created_at timestamptz`, `updated_at timestamptz`, `processed_at timestamptz?` |
| `wallet_ledger_entries` | `wallet_id uuid`, `transaction_id uuid`, `direction text`, `currency varchar(3)`, `amount money`, `balance_before money`, `balance_after money`, `created_at timestamptz`                                                                                                                                                                                                                                                                                                                                                                               |
| `inbox_messages`        | `consumer_name text`, `message_id text`, `payload_hash text`, `status text = RECEIVED`, `attempts integer = 0`, `last_error text?`, `received_at timestamptz`, `updated_at timestamptz`, `processed_at timestamptz?`                                                                                                                                                                                                                                                                                                                                    |
| `outbox_messages`       | `event_id uuid`, `aggregate_id uuid`, `event_type text`, `event_version integer`, `correlation_id text`, `causation_id text?`, `payload jsonb`, `status text = PENDING`, `attempts integer = 0`, `last_error text?`, `occurred_at timestamptz`, `created_at timestamptz`, `next_attempt_at timestamptz`, `published_at timestamptz?`                                                                                                                                                                                                                    |
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
| Idempotency        | `idempotency_scope_key_unique(scope,idempotency_key)`; estados IN_PROGRESS/COMPLETED; COMPLETED exige transação e original_result objeto JSONB. Resultado é snapshot persistido, independente do saldo atual. Algoritmo do hash e momento de completar continuam pendentes.                                                                                                                                                                                  |

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

| Nome                              | Colunas / predicado                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `wager_wallet_history_idx`        | `(wallet_id,created_at,id)`                                                                           |
| `wager_reference_idx`             | `(reference_transaction_id)`                                                                          |
| `wager_pending_reference_idx`     | `(next_attempt_at,created_at,id) WHERE status = 'PENDING_REFERENCE'`                                  |
| `wager_processed_reversal_unique` | UNIQUE `(reference_transaction_id,kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| `ledger_wallet_history_idx`       | `(wallet_id,created_at,id)`                                                                           |
| `outbox_pending_due_idx`          | `(next_attempt_at,created_at,id) WHERE status = 'PENDING'`                                            |
| `idempotency_transaction_idx`     | `(transaction_id)`                                                                                    |

A unicidade de reversão protege sucesso por tipo; tentativas rejeitadas continuam auditáveis e REFUND não bloqueia automaticamente um ROLLBACK. O schema não decide a interação financeira dessas operações. O futuro processador deve agendar next_attempt_at, classificar falhas e coordenar aquisição concorrente; não há leases ou limites de tentativas escolhidos nesta etapa.

## Migration e reversão

[`Migration202610280001`](../src/platform/persistence/migrations/Migration202610280001.ts) cria as seis tabelas, constraints, índices e duas funções/triggers. Migrator registra a execução em `mikro_orm_migrations`, uma tabela técnica adicional às seis de aplicação. Up/down são transacionais, all-or-nothing e não desabilitam FKs.

Down adquire lock exclusivo do ledger e recusa a operação se houver qualquer lançamento, preservando histórico confirmado. Em banco descartável sem ledger, remove tabelas e funções em ordem inversa; wallets e outros registros descartáveis são apagados. Não usar down como remediação financeira. Com histórico real, fazer migration corretiva forward; nenhum trigger impede um administrador privilegiado de alterar o schema deliberadamente.

Não usar `schema:update`, `schema:fresh` ou sincronização no deploy. CLI deve rodar uma vez pelo procedimento de release antes da API. Coordenação entre múltiplos executores simultâneos de migrations não faz parte deste estágio.

## Verificação reproduzível

`bun test test/persistence.test.ts` sobe o mesmo Compose em projeto exclusivo, com porta dinâmica, credenciais efêmeras e volume descartável; executa CLI real para up/status/down/up e remove somente seus próprios recursos. Não toca no banco configurado pelo desenvolvedor. Requer Docker Desktop/Engine com Compose, imagem disponível ou acesso ao registry. Sem mocks, SQLite ou skips automáticos quando Docker falta.

Os testes verificam catálogos PostgreSQL e violações por SQL/ORM: seis tabelas, FKs e índices, wallet única, saldo/versão, precisão e dirty checking de centavos acima de 53 bits, identidades externas, OPENING, referências pendentes, reversões por tipo, Inbox/Outbox/idempotência únicas, integridade de contexto, ledger aritmético/imutável, resultado original e eventos recuperáveis por conexão independente. Commit/rollback cobrem múltiplas tabelas; rollback demonstra ausência de efeitos nas seis. Contextos têm identity maps e transações isolados.

O teste de lock mantém `PESSIMISTIC_WRITE` numa wallet e, após confirmar a aquisição, inicia dois processos Bun independentes: NOWAIT na mesma wallet falha com 55P03; outra wallet adquire lock. Após commit, a primeira também fica disponível. PIDs e resultados aparecem na saída. Não há sleep para fabricar concorrência, lock global ou teste de apostas implementado artificialmente.

`bun test test/api.test.ts` usa outro container isolado e comprova inicialização Nest, HTTP liveness real e fechamento do pool. A suíte normal `bun run test` inclui esses testes e os testes negativos de arquitetura, inclusive rejeição de imports ORM em domínio/aplicação.

Pendências: Money/rehydrate, adapters/portas de domínio (inclusive OPENING), atomicidade e versão nos casos de uso, zero por operação, transições terminais, referências já existentes mas não processadas, hash canônico/escopo de idempotência, evolução de resultados pendentes, backoff/TTL, claims/leases, publishers concorrentes e crash recovery dos futuros workers. O teste de lock não comprova concorrência financeira completa com três instâncias (§13).

## Evidências desta entrega — 2026-10-28

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
