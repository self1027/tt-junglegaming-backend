# Fundação PostgreSQL / MikroORM

Decisão e ambiguidades: [ARCHITECTURE.md](../ARCHITECTURE.md#fundação-de-persistência--decisão-aprovada-nesta-tarefa). Requisitos: §§4–6, 7.1, 9–11 e 13 do [enunciado imutável](challenge.md), [Financial](domain/financial.md), [Wagering](domain/wagering.md) e [Messaging](domain/messaging.md).

Entregue: armazenamento, integridade estrutural e [integração financeira transacional](#integração-financeira-e-unitofwork) com portas, mappers e adapters. Os modelos não são entidades de domínio. Não há caso de uso de processamento financeiro, consumer, publisher ou algoritmo de idempotência.

## Versões e execução

- PostgreSQL **18.3**, imagem oficial `postgres:18.3-bookworm` com digest no [Compose](../compose.yaml).
- MikroORM core/driver/migrations/CLI **7.2.5**; integração NestJS **7.1.0**; Bun **1.4.4**; NestJS **11.2.8**.
- [Configuração](../src/platform/persistence/config.ts) recebe ambiente validado, exige credenciais, usa pool min 0/max configurável (10 por padrão), timeout de conexão 5s e timeout ocioso 30s. Sem contexto global, criação automática de banco ou sincronização de schema.
- [Modelos](../src/platform/persistence/models.ts) registrados explicitamente; [`ExactNumericType`](../src/platform/persistence/exact-numeric.type.ts) mantém strings na conversão e na comparação de alterações. Não usa conversão monetária por number.
- Integração oficial Nest cria contexto por requisição e fecha pool no encerramento; o entrypoint já habilita shutdown hooks. Startup exige banco acessível, mas `/health/live` continua verificando apenas o processo HTTP, sem consultar PostgreSQL.

Setup e comandos estão no [README](../README.md). `db:status` mostra migrations executadas e pendentes. `db:migrate` aplica; `db:rollback` reverte a última. CLI executado pelo Bun, instalado somente em desenvolvimento; executar migrations pelo checkout com dependências completas antes de subir a imagem da API. O Dockerfile existente é preservado e não executa migrations no startup.

## Convenções físicas

`id` é UUID PK com default `gen_random_uuid()` em todas as seis tabelas. IDs de player/provider/round/game/message e chaves externas são TEXT, sem impor UUID aos identificadores externos. Todas as datas são TIMESTAMPTZ. `created_at`, `updated_at`, `received_at` e `next_attempt_at` da Outbox têm default `current_timestamp` quando presentes. `updated_at` deve ser informado pelo futuro adapter ao alterar o registro; não há hook que esconda uma decisão de aplicação.

`money` na tabela abaixo significa **NUMERIC sem typmod**, NOT NULL, finito, não negativo e `scale(value) = 2`. O banco rejeita `1.001`, `1`, NaN e infinitos, sem arredondar; gravar `1.00`. Isso mantém escala exata sem escolher um teto comercial ausente do contrato. O limite técnico permanece o do PostgreSQL. Validação lexical da string também existe no tipo técnico ORM; Money e catálogo ISO-4217 pertencem ao [domínio Financial](domain/financial.md).

Compatibilidade do núcleo financeiro: Money não negativo serializa strings canônicas aceitas por ExactNumericType; seus resultados negativos internos não são persistíveis nessas colunas. Wallet mantém UUID/texto/moeda, saldo não negativo, versão INTEGER e datas; ledger mantém UUIDs, direção e equação compatíveis. O domínio é mais restritivo que os checks SQL: rejeita moeda fora do catálogo, identidades/textos inválidos, datas inconsistentes e lançamento zero, permitido aritmeticamente pelo schema. Isso não exige alterar a migration: todo estado aceito pelo domínio cabe nas representações existentes, sujeito aos limites técnicos do PostgreSQL. Os mappers preservam esse estado, com evidência de atomicidade na integração abaixo.

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

Pendências: casos de uso que coordenem os adapters, zero por operação de aposta, transições terminais, referências já existentes mas não processadas, hash canônico/escopo de idempotência, evolução de resultados pendentes, backoff/TTL, claims/leases, publishers concorrentes e crash recovery dos futuros workers. Os testes dos adapters abaixo usam três processos, mas não comprovam o processador completo (§13).

## Integração financeira e UnitOfWork

Implementação autorizada pela tarefa Financial Persistence Integration & Transactional UnitOfWork; atende a persistência de §§5, 6.0–6.4, 8–9 e 13 sem antecipar ProcessWagerUseCase. Sem migrations novas nem alterações nas constraints, configuração de conexão ou regras de arquitetura.

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

As escritas são parametrizadas pelo ORM, executadas imediatamente no EntityManager transacional. Nenhum repositório abre transação ou faz commit/flush independente. Uma falha de FK/UNIQUE/CHECK mantém código PostgreSQL reconhecível pelo chamador. O contexto mínimo não contém Inbox, Outbox ou idempotência: serão acrescentados quando seus fluxos forem implementados.

Ordem de criação: **wallet → transação financeira → ledger**, por causa das FKs imediatas. Em wallet existente, adquirir lock antes de qualquer cálculo sobre saldo; atualizar wallet e inserir a transação antes de inserir o ledger. Erro posterior reverte todos os efeitos. Os testes também escrevem transação/ledger antes de uma atualização que falha, para comprovar rollback dessa ordem. UnitOfWork garante a fronteira atômica, não exige efeitos de negócio: cabe ao futuro coordenador associar cada BalanceChange ao registro e ledger corretos.

`lockById` usa PESSIMISTIC_WRITE (`FOR UPDATE`), espera o detentor e mantém lock até commit/rollback. A wallet é reconstruída com refresh após aquisição, evitando identity map obsoleto. Para várias wallets, adquirir sequencialmente em **ordem crescente dos UUIDs canônicos em minúsculas**, independentemente da ordem de entrada. Não há mutex global ou lock em memória como garantia. O mapa local apenas associa a instância devolvida ao lock já obtido no banco. Ausência de registro retorna undefined; criação concorrente continua protegida pela UNIQUE de player/moeda, sem presumir lock de registro inexistente.

`insert` nunca atualiza uma wallet existente. `save` exige exatamente a instância retornada pelo lock naquela execução; leituras simples e objetos de outro contexto não podem sobrescrever saldo. O UPDATE condiciona ID e versão observada sob lock, exigindo uma linha alterada: **versão é proteção adicional e rastreabilidade**, enquanto o lock serializa o cálculo financeiro. A versão vem do domínio; o ORM não a incrementa. Sem mudança, save não executa UPDATE nem altera timestamps. Isso permite leitura/replay sem efeitos; replay de wagering ainda não existe.

A [proposta registrada antes da implementação](financial-persistence-proposal.md) adicionou `Wallet.open` sem alterar `create` ou `rehydrate`; detalhes pertencem a [Financial](domain/financial.md#abertura-9). Abertura positiva é testada com OPENING legítima e ledger, versão 1; abertura zero não gera registro financeiro. Não há endpoint nem caso de uso de abertura.

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
