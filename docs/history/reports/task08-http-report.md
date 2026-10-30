> HISTORICAL: registro da etapa indicada. Estado atual em [docs/index](../../index.md).

# Task 08 — HTTP API, abertura e reconciliação

## Git e preservação

Branch de trabalho: **feat/http-api**. Inspeção inicial executou status, branch atual/lista e log. O checkout estava limpo em feat/transactional-outbox, sincronizado com origin, no commit `d8506a6ccd1fbf8eb301e29c3452f9c3d31538a1`. A branch antiga task07-transactional-outbox já não era a branch atual; não foi necessário renomear, separar alterações ou criar commits de preservação.

feat/http-api foi criada diretamente desse ponto. A referência feat/transactional-outbox foi preservada integralmente. Não havia staged/unstaged ou alterações anteriores pendentes. Nenhum reset, clean, rebase, merge ou exclusão de branch foi executado. Após revisar a implementação, o usuário autorizou organizar commits com no máximo 500 linhas alteradas (adições + remoções) e publicar feat/http-api em origin. A divisão é por responsabilidade; o arquivo HTTP maior é registrado em dois blocos completos de testes por staging parcial, preservando seu conteúdo final. Não há merge na main nem alteração da referência da Task 07.

## Resultado e contratos

[Contrato completo, JSON e curl](../../contracts/http.md). Controllers só validam/adaptam/delegam; processamento financeiro usa o ProcessWagerUseCase existente e a mesma UnitOfWork/Outbox. Novos casos de uso Financial: CreateWalletUseCase, QueryWalletUseCase e ReconcileWalletUseCase. QueryWagerUseCase cobre as consultas exigidas sem expor ORM/key/hash.

| Endpoint                                                                | Resultado normal                                |
| ----------------------------------------------------------------------- | ----------------------------------------------- |
| POST /wallets                                                           | 201, saldo exato e versão 1                     |
| GET /wallets/:walletId                                                  | 200, DTO de wallet                              |
| GET /wallets/:walletId/ledger                                           | 200, página com cursor opaco                    |
| POST /wallets/:walletId/reconciliation                                  | 200, diagnóstico sem escrita                    |
| POST /wagering/transactions                                             | 200 processado, 202 pendente, 422 rejeitado     |
| GET /wagering/transactions/:transactionId                               | 200, transação externa                          |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | 200, identidade externa                         |
| GET /health/live                                                        | 200 sem acesso ao banco                         |
| GET /health/ready                                                       | 503; PostgreSQL verificado e SQS not_configured |

Entrada Wagering usa money MoneyProps do §9 e Idempotency-Key explícito. Pipes runtime rejeitam campos extras, estrutura/tipos inválidos, dinheiro number, escala/sinal/expoente inválidos, moeda desconhecida e identidades Unicode malformadas. O caso de uso verifica walletId obrigatório no HTTP, inclusive em replay, sem mudar hash canônico/escopo existentes.

Replay mantém resultado e saldo histórico com idempotentReplay true, sem nova versão/ledger/transação/evento. Payload divergente na mesma key e outra key para a mesma identidade externa continuam conflitos distintos. Nenhuma rejeição Wagering artificial é criada por conflito de transporte ou erro técnico. Rejeição persistida usa 422 e failureCode, diferenciada de entrada inválida (400) e pendência (202).

O filtro HTTP central sanitiza erros. Wallet inexistente é 404; duplicação é 409 somente para SQLSTATE 23505 com constraint wallets_player_currency_unique. Demais violações inesperadas não são convertidas nesse conflito. Falhas transitórias classificáveis usam 503; inesperadas 500. Adapters continuam propagando os códigos SQL originais, preservando o contrato anterior.

## Abertura, reconciliação e integridade

Inicial zero cria wallet a 0.00, versão 1, sem OPENING/ledger/evento. Inicial positivo usa Wallet.open e grava wallet→OPENING→CREDIT numa transação; falha em qualquer participante reverte tudo. A constraint player/moeda serializa criações concorrentes sem mutex global e sem OPENING órfã. OPENING permanece interno a Financial, sem evento Wagering inventado.

Reconciliação soma créditos e subtrai débitos por Money desde zero. Considera abertura, movimentos e reversões; LOSS não produz lançamento. Diferença é armazenado−reconstruído e preserva sinal. Confere continuidade de saldos, inclusive empates de timestamps com ordem por UUID diferente da ordem financeira. Incoerência histórica pode produzir consistent false mesmo com diferença zero.

UnitOfWork oferece opção localizada readOnly: fork transacional REPEATABLE READ + SET TRANSACTION READ ONLY. Wallet e ledger compartilham o snapshot; um servidor pode confirmar movimento entre as duas consultas sem produzir leitura incompatível. Não há lock exclusivo ou transação financeira aninhada. PostgreSQL rejeitou INSERT com 25006 no teste desse modo. Escritas normais preservam READ COMMITTED e a ordem de locks anterior.

Divergência retorna consistent false, registra log JSON seguro e incrementa contador da instância; não ajusta registros nem cria compensação. Exportação/agregação de métricas permanece pendente. Ledger paginado usa âncora na linha SQL imutável, preservando microssegundos, com limit padrão50/máximo100.

## Concorrência HTTP e recuperação

[Harness](../../../test/http-concurrency.test.ts) iniciou três servidores Nest/Bun independentes compartilhando PostgreSQL 18.3. PIDs na execução final: **4516, 22244, 9288**. São três processos servidores, além do cliente de teste. Cada servidor tem seu próprio pool. Barreiras de teste ficam exclusivamente em test/support; não há hooks financeiros de teste em produção.

| Cenário           | Evidência                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 100/80/80         | Primeiro servidor retido antes do commit; segundo observado esperando lock em pg_stat_activity. Uma PROCESSED, outra REJECTED, saldo 20.00, versão 2, um débito e três eventos PENDING (dois de sucesso, um de rejeição) |
| Wallets distintas | Terceiro servidor confirma movimento de outra wallet enquanto o primeiro permanece na barreira; sem mutex global                                                                                                         |
| 50 duplicatas     | Uma operação retida antes de commit, concorrentes observados em espera SQL em outros dois servidores; uma aplicação, 49 replays, uma WagerTransaction, um registro idempotente, um débito e dois eventos                 |
| Criação duplicada | INSERT concorrente observado esperando; um 201, outro 409 específica, uma wallet, uma OPENING, um CREDIT, versão 1, sem eventos Wagering                                                                                 |
| Snapshot          | Servidor1 retido depois de ler wallet 100.00; servidor2 confirma BET 10.00; leitura posterior do ledger no servidor1 continua no snapshot 100.00. Reconciliação seguinte confirma 90.00                                  |
| Resposta perdida  | Requisição interrompida pelo cliente depois de sinal de commit e antes da resposta; outro servidor consulta efeitos confirmados, nova BET altera saldo e replay em terceiro devolve saldo histórico 90.00                |

Contagens, versões, saldo materializado/reconstruído e eventos PENDING são lidos diretamente do PostgreSQL. O harness confere fechamento do pool nos três processos, com teardown mesmo após falhas e prazo de encerramento. Polling limitado observa estados reais, sem sleeps usados como prova de corrida.

Regressões anteriores passaram integralmente: crashes antes/depois do commit, idempotência multiprocesso, reversões concorrentes, precisão acima de 53 bits, Unicode, ledger append-only, versionamento e falha no segundo evento Outbox. A suíte HTTP também injeta falha no segundo evento depois de observar o primeiro: wallet/ledger/transação/idempotência/Outbox revertem juntos e retry posterior aplica uma vez. Eventos continuam PENDING; nada foi publicado.

## Validação executada

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.1, PostgreSQL 18.3 em projetos Compose/volumes descartáveis. Docker Desktop estava desligado inicialmente e foi iniciado; nenhum banco principal foi usado para fixtures/divergências.

| Comando/check                                           | Resultado                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bun run typecheck                                       | Passou                                                                                                                                                            |
| bun run lint                                            | Passou, incluindo arquitetura: 66 módulos/227 dependências, zero violações                                                                                        |
| bun run test                                            | **309 passaram, 0 falharam, 2.813 asserções, 17 arquivos, 63,37 s**                                                                                               |
| bun run build                                           | Passou                                                                                                                                                            |
| Migrations reais                                        | Suíte executou up/status/down/up e migration adicional de reversões preservando histórico em banco descartável                                                    |
| Arquitetura negativa                                    | 21 testes anteriores passaram; nenhuma regra relaxada                                                                                                             |
| Snapshot read-only                                      | Isolamento repeatable read/read_only on lidos na sessão; INSERT rejeitado25006                                                                                    |
| Inicialização/shutdown                                  | Nest real; três pools separados encerrados; containers/volumes removidos pelo harness                                                                             |
| docker build -t distributed-wagering-processor:task08 . | Passou com Dockerfile existente, dependências frozen e usuário bun                                                                                                |
| Smoke da imagem                                         | Passou: abertura 201, BET 200, replay histórico, ledger, reconciliação com 2 entradas, dois eventos PENDING, readiness 503 e shutdown pelo SIGTERM do docker stop |

O smoke iniciou outro PostgreSQL descartável, aplicou migrations e conectou a imagem pela rede Compose exclusiva. A imagem final tem manifest list `sha256:bb4c05b99f889ca3c0cc856d5d3fae288cc02d62aca03a987bf51120588ff77a`. Recursos descartáveis foram removidos; somente a imagem local foi mantida. Não houve push da imagem.

A primeira suíte completa detectou uma alteração indevida na propagação 23505 do adapter. O adapter original foi restaurado e a tradução ficou no filtro HTTP. A suíte seguinte passou 307/307; após acrescentar readiness e verificação SQL read-only, a suíte final passou 309/309. Nenhum teste anterior foi removido ou teve suas asserções financeiras enfraquecidas.

Conferência documental final: `bun run format:check` e `git diff --check` passaram; 287 links/âncoras locais em 12 documentos alterados resolveram sem falhas. Documentos humanos não exigem frontmatter; nenhum frontmatter de skill foi alterado. Enunciado, migrations, package/lockfile e regras estáticas foram conferidos sem diff. Apenas o container PostgreSQL preexistente `verzel-postgres` permaneceu na listagem; nenhum recurso descartável desta tarefa ficou ativo.

Graphify foi consultado antes da exploração, atualizado operacionalmente e consultado novamente: **905 nós, 2.170 relações**. Localizou CreateWalletUseCase, ReconcileWalletUseCase, WalletController e QueryWagerUseCase; graph:path confirmou WalletController → arquivo do controller → ReconcileWalletUseCase. Extração estrutural sem LLM/API. Cinco arquivos não geram símbolos individuais, incluindo barrels/configuração/fixtures; conteúdo pertinente e imports foram conferidos diretamente. O índice não substitui os contratos nem a validação arquitetural.

## Revisão independente

Revisor separado trabalhou somente em leitura. Identificou timeout de pg-pool sem SQLSTATE retornando 500 durante saturação. O caso foi reproduzido com pool 1; teste falhou com 500 e passou com 503 após reconhecimento dos dois textos exatos da biblioteca instalada. O revisor também apontou que a fixture de cursor ainda não forçava microssegundos: agora usa 000001/000002/000002 e UUIDs adversos à truncagem, com ordem completa assertada.

O revisor conferiu essas correções e a preservação da propagação 23505: testes HTTP selecionados 5/5 (32 asserções), adapter 1/1 (3 asserções). Anteriormente executou casos de uso Financial/processador 44/44 (163 asserções). Também conferiu readiness/guard no-op e executou o teste de readiness: 1 passou, zero falhas, 2 asserções. Não encontrou outros defeitos concretos em abertura, Unicode/Money, replay, cadeia histórica, snapshot ou DI. As pendências documentais apontadas (relatório e status local de observabilidade) foram resolvidas. A suíte completa e o smoke são evidências do executor, não atribuídas ao revisor.

## Inventário

Criados:

- Financial application: [create-wallet.use-case.ts](../../../src/modules/financial/application/create-wallet.use-case.ts), [query-wallet.use-case.ts](../../../src/modules/financial/application/query-wallet.use-case.ts), [reconcile-wallet.use-case.ts](../../../src/modules/financial/application/reconcile-wallet.use-case.ts), [wallet-result.ts](../../../src/modules/financial/application/wallet-result.ts) e contrato público [wallet-api.ts](../../../src/modules/financial/public/wallet-api.ts).
- Financial HTTP: [wallet.controller.ts](../../../src/modules/financial/adapters/http/wallet.controller.ts) e [wallet-input.ts](../../../src/modules/financial/adapters/http/wallet-input.ts).
- Wagering: [query-wager.use-case.ts](../../../src/modules/wagering/application/query-wager.use-case.ts), [wager.controller.ts](../../../src/modules/wagering/adapters/http/wager.controller.ts), [wager-input.ts](../../../src/modules/wagering/adapters/http/wager-input.ts).
- Bootstrap: [http-error.filter.ts](../../../src/bootstrap/http-error.filter.ts), [no-auth.guard.ts](../../../src/bootstrap/no-auth.guard.ts), [readiness.ts](../../../src/bootstrap/readiness.ts), [reconciliation-diagnostics.ts](../../../src/bootstrap/reconciliation-diagnostics.ts).
- Platform: [validação HTTP](../../../src/platform/http/input.ts), [contrato readiness](../../../src/platform/observability/readiness.ts), [classificação PostgreSQL](../../../src/platform/persistence/postgres-error.ts).
- Testes: [wallet-use-cases](../../../test/wallet-use-cases.test.ts), [http-input](../../../test/http-input.test.ts), [http-api](../../../test/http-api.test.ts), [http-concurrency](../../../test/http-concurrency.test.ts), [processo HTTP](../../../test/support/http-process.ts), [harness de servidores](../../../test/support/http-server.ts).
- Documentação: [HTTP](../../contracts/http.md), [plano](../plans/2026-10-29-http-api.md), este relatório.

Modificados:

- [ApiModule](../../../src/bootstrap/api.module.ts), [HealthController](../../../src/platform/observability/health.controller.ts), [UnitOfWork técnico](../../../src/platform/persistence/mikro-orm-unit-of-work.ts).
- [Financial exports](../../../src/modules/financial/public/index.ts), [portas](../../../src/modules/financial/public/persistence.ts), [ledger adapter](../../../src/modules/financial/adapters/persistence/mikro-orm-ledger.repository.ts).
- [Comando Wagering](../../../src/modules/wagering/public/process-wager.ts), [snapshot de entrada](../../../src/modules/wagering/application/canonical-wager.ts), [ProcessWagerUseCase](../../../src/modules/wagering/application/process-wager.use-case.ts) e [testes existentes ampliados](../../../test/process-wager.test.ts).
- [README](../../../README.md), [arquitetura](../../../ARCHITECTURE.md), [requisitos](../../requirements.md), [Financial](../../domain/financial.md), [Wagering](../../domain/wagering.md), [Messaging](../../domain/messaging.md) e [persistência](../../persistence.md). Status local atualizado em AGENTS.md raiz e nas instruções de observabilidade, sem relaxar regras.

Enunciado, migrations, package/lockfile, ESLint, Dependency Cruiser, núcleo monetário e adapters originais de wallet/OPENING/Outbox permanecem preservados.

## Limites e próxima etapa

- Readiness completo depende de SQS; rota existe mas permanece 503. Nenhum SQS/LocalStack, Inbox, consumer, publisher, worker, DLQ, retry ou reprocessamento agendado foi antecipado.
- Autenticação é omitida: guard no-op é apenas ponto de extensão, não proteção de acesso.
- Contador de divergências é local, sem exporter/agregação/durabilidade. Observabilidade completa continua pendente.
- Reconciliação lê todo o histórico em memória; páginas HTTP têm snapshots próprios. Não se promete snapshot único durante múltiplas páginas.
- O novo teste de resposta incerta interrompe o cliente após commit; os testes anteriores continuam exercitando morte efetiva do processo antes/depois de commit. Não foi adicionado um segundo teste de kill HTTP equivalente.
- Não há entrega exactly-once ou publicação de eventos. Pendências HTTP só evoluirão quando o worker for implementado.

Próxima etapa recomendada: SQS/Inbox/ACK e readiness completo sobre o mesmo ProcessWagerUseCase; depois publisher recuperável e worker de referências, com eventos persistidos e testes reais. Integração com IdP e exportação das métricas são trabalhos separados.
