# Task 11 — Pending Reference Worker e resolução terminal

## Git e resultado

Branch `feat/pending-reference-worker`, criada diretamente de
`feat/outbox-publisher` no commit `704dea0fedd26af067f086f281dc29b2f9c3cb3b`.
Checkout inicial limpo; fetch confirmou local/remoto iguais. A Task 10 está
preservada como ancestral, e sua branch não foi alterada. Sem commit, push,
merge, rebase, reset, clean ou exclusão de branch. O usuário realizará os commits.
Alterações desta tarefa permanecem no working tree para revisão.

Worker Nest independente em [main.pending-worker.ts](../src/main.pending-worker.ts),
sem HTTP/SQS, com pool próprio. [Operação/configuração](pending-reference-worker.md),
[contrato e matriz de estados](domain/wagering.md#task-11--resolução-de-referências),
[decisão arquitetural](../ARCHITECTURE.md#task-11--worker-de-referências) e
[persistência](persistence.md#task-11--claims-de-referências).

## Contratos e implementação

- ResolvePendingWagerUseCase processa a entidade pendente existente. A extração
  de processWager/saveWagerBalanceChange permite compartilhar referências,
  reversões, Wallet e associação de ledger com ProcessWagerUseCase. Nenhum novo
  Money, motor, tabela de ledger, publisher ou identidade de operação.
- Recupera PENDING_REFERENCE e PENDING com referência externa; exclui OPENING e
  PENDING sem referência. Ausência e referência ainda não processada são causas
  distintas. Espera preserva snapshot aceito e estado compatível, sem novos fatos.
- TTL configurável de 24h desde created_at, explicitamente aprovado pelo usuário;
  política local, pois §7.1 não fixa valor. Backoff exponencial com jitter de
  1s até 5min. A referência é revalidada: se já elegível, processa mesmo depois
  do prazo. Ausência/incompletude vencidas usam códigos específicos. Falha SQL
  não consome o TTL como rejeição nem cria FAILED artificial.
- Migration incremental **Migration202610290002** acrescenta claim_token,
  claimed_by, claimed_until e CHECK, mais índice parcial de vencimento para os
  dois estados. COALESCE cobre scheduling NULL legado. Migrations anteriores,
  constraints financeiras/reversões e enunciado permanecem intactos.
- Aquisição curta com SKIP LOCKED e commit antes de esperar wallet. Attempts
  conta claims confirmados; last_attempt_at usa relógio SQL. Lease finito sem
  renovação; readquisição gera token novo. Não há lock global ou claim de Outbox
  reutilizado para Wagering.
- Ordem: Inbox somente no SQS; depois idempotência → identidade externa → wallet
  → referência/histórico. Worker adquire a mesma ordem, colocando validação/lock
  da pendência após wallet. Publisher só coordena Outbox e não participa dos locks
  financeiros. Claims curtos não mantêm lock enquanto aguardam esses recursos.
- Uma UnitOfWork confirma saldo/versão/ledger, resultado idempotente terminal,
  novos eventos e UPDATE final da operação/claim. O último UPDATE exige token,
  estado esperado não terminal e lease válido. Expiração/falha reverte tudo.
  Nenhuma transação financeira é confirmada antes do estado Wagering.
- IdempotencyRepository bloqueia registro COMPLETED já existente; não insere
  nova reserva. Atualização condicional exige scope/key/hash/transaction_id e
  identidades do JSON, com snapshot anterior pendente. Não sobrescreve terminal
  nem saldo histórico. Replay concorrente espera e observa a ordem dos commits.
- Outbox recebe Processed + BalanceChanged somente se há movimento, ou Rejected
  sem saldo. LOSS não gera BalanceChanged. EventIds novos identificam os novos
  fatos; evento histórico de pendência permanece imutável. Retry/replay/claim
  perdido não criam novos fatos. Contrato v1 version/data preservado.
- Timeout de statement = SQL; transaction_timeout = SQL + 1000ms permite margem
  de rollback; aquisição do pool = SQL. Lease/shutdown >= 2 × SQL + 2000ms.
  Transação total ainda pode encerrar conexão, mantendo recuperação por lease.
- SIGTERM/SIGINT param aquisição e drenam operações iniciadas. Prazo excedido
  encerra com 1; transação incompleta não confirma, e outro processo recupera.
  Processo abruptamente morto não depende de hooks.

## Evidências executáveis

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.0, PostgreSQL 18.3 e
LocalStack 4.14.0 reais, imagens pinadas no Compose; containers Linux. Harness
existente com projetos/volumes/portas isolados e teardown. Nenhum dado do banco
do desenvolvedor foi removido.

| Cenário                   | Evidência                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estados/referências/TTL   | Ausente, PENDING, cadeia, PROCESSED, REJECTED, FAILED, incompatibilidade, duplicata/cumulatividade e saldo insuficiente; referência pronta após TTL ainda processa                             |
| Precisão                  | BET/REFUND e WIN/ROLLBACK de 9007199254740993.01, saldo inicial 9007199254741093.01; strings exatas em SQL/JSONB/FIFO; versão e ledger reconciliados                                           |
| Migration                 | Up/status/down/up com PENDING/PENDING_REFERENCE/PROCESSED legados; histórico preservado e novos claims válidos                                                                                 |
| Aquisição                 | Limite, scheduling futuro, NULL legado, SKIP LOCKED sobre linha efetivamente bloqueada e EXPLAIN com range Index Cond no índice parcial                                                        |
| Fencing                   | Token novo com mesmo owner, sucesso/retry obsoletos recusados, terminal inelegível e lease expirando depois das escritas financeiras com rollback integral                                     |
| Atomicidade               | Falhas reais PostgreSQL em wallet, INSERT ledger, UPDATE Wager, UPDATE idempotência, primeiro/segundo evento; erro após finalização antes de commit                                            |
| Três processos            | Três Bun com pools independentes, sinais stdin/JSON e pg_stat_activity para provar contenção; uma resolução, um crédito e um conjunto terminal de eventos                                      |
| Reversões concorrentes    | REFUND e ROLLBACK sobre a mesma BET: uma processada, outra rejeitada por cumulatividade; replay concorrente espera idempotência                                                                |
| Original versus worker    | BET/WIN suspensa antes de commit; worker espera wallet e relê referência confirmada; outra wallet progride em terceiro processo                                                                |
| Crash antes de commit     | SIGKILL na barreira após escritas e antes do commit; observador confirma saldo/idempotência/Outbox antigos; lease expira e sucessor aplica uma vez                                             |
| Crash após commit         | SIGKILL antes de devolver resultado; estado/ledger/idempotência/eventos já duráveis; outros processos não selecionam terminal                                                                  |
| Cadeia                    | BET → REFUND → ROLLBACK de REFUND: espera por referência efetivamente processada e saldo final 20.00 após reversão do crédito                                                                  |
| HTTP/SQS/worker/publisher | REFUND e ROLLBACK fora de ordem; replay HTTP e nova mensagem SQS antes/durante/depois da resolução; Inbox/ACK após commit, cinco fatos por fluxo publicados e comparados integralmente no FIFO |
| Docker normal             | Build real, worker compilado sem HTTP/SQS, SIGTERM real, drenagem durante espera por wallet, saída 0 e reconciliação                                                                           |
| Timeout SQL               | Statement cancelado, snapshot não terminal preservado, SQL_UNCERTAIN/backoff persistidos; shutdown sai 0 e sucessor resolve                                                                    |
| Deadline externo          | PostgreSQL pausado durante execução bloqueada; SIGTERM/log de deadline/saída 1; unpause e novo worker recuperam uma vez                                                                        |

Na execução distribuída selecionada, os três workers usaram PIDs
**16876/17344/16868**. Reversões/replay: **11496/7404/3940**. Crash antes de commit:
**10848 → 15944**, terceiro **1884** sem trabalho; depois de commit:
**7796 → 2336/4752**, ambos sem reabrir. Lease obsoleto:
**2196 → 7032**, terceiro **9000**. Barreiras e estado SQL, não sleeps isolados,
comprovam as janelas. Reconciliação final consistente em todos os fluxos.

## Validação consolidada

Resultados das execuções selecionadas:

| Comando                                                                    | Resultado                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| bun test test/pending-worker.test.ts                                       | 19 passaram, 0 falharam, 35 asserções; sem PostgreSQL                                         |
| bun test test/pending-persistence.test.ts                                  | 25 passaram, 0 falharam, 294 asserções; PostgreSQL real                                       |
| bun test test/pending-distributed.test.ts test/pending-persistence.test.ts | Execução anterior: 28 passaram, 0 falharam, 376 asserções; antecede três casos SQL adicionais |
| bun test test/pending-pipeline.test.ts                                     | 2 passaram, 0 falharam, 37 asserções; HTTP/PostgreSQL/LocalStack reais                        |
| bun test test/pending-docker.test.ts                                       | 4 passaram, 0 falharam, 41 asserções; inclui build/sinais/deadline                            |
| bun run typecheck                                                          | Passou                                                                                        |
| bun run lint                                                               | Passou; 103 módulos/372 dependências, sem violações                                           |
| bun run test                                                               | **447 passaram, 0 falharam, 3.912 asserções, 33 arquivos, 471,76s**                           |
| bun run build                                                              | Passou; worker compilado incluído                                                             |
| bun run format:check                                                       | Passou                                                                                        |
| git diff --check                                                           | Passou                                                                                        |

A suíte completa preservou os **388 testes anteriores** e acrescentou 59.
Inclui PostgreSQL/LocalStack, migrations, HTTP, Inbox/ACK/DLQ, publisher, Docker
build/smoke/SIGTERM, três processos independentes e reconciliação. Não houve
falhas na execução consolidada. Todos os containers/volumes descartáveis foram
encerrados/removidos; imagens de smoke permanecem locais.

Documentação UTF-8, frontmatter e 373 links/âncoras relativos conferidos nos 16
documentos alterados/novos. A revisão documental identificou referências antigas
ao worker futuro, hierarquia de headings e corrupção de acentos por piping no
PowerShell; corrigidos antes da conferência final. O enunciado, lockfile e as
três migrations anteriores permanecem sem alterações no Git.

Graphify consultado antes da exploração e atualizado depois da implementação:
**1.304 nós e 3.437 relações**, extração local sem LLM/API. Consulta
`ResolvePendingWagerUseCase` localizou aplicação, portas, adapter SQL, worker e
composição. `graph:path PendingWorkerModule processWager` confirmou caminho
estrutural em três saltos até a lógica compartilhada. Nove arquivos não produziram
símbolos individuais, incluindo main.pending-worker.ts e barrels; imports e
entrypoints foram conferidos diretamente. O índice não comprova garantias de
concorrência e não substitui os testes reais.

## Revisão independente e correções

Revisor separado, somente leitura, conferiu núcleo compartilhado, callers,
idempotência/locks/claims/TTL, fronteiras e testes novos. Não encontrou defeito
financeiro bloqueante. Executou independentemente unidade/processador (50 testes,
154 asserções), PostgreSQL (22 testes, 266 asserções da versão anterior aos três
casos adicionais) e 49 testes de unidade/arquitetura (89 asserções naquele checkpoint).

O revisor pediu valor da própria operação acima de 53 bits; o teste SQL e o
pipeline agora usam 9007199254740993.01 com centavos. Também apontou ausência de
deadline efetivamente excedido; o quarto teste Docker cobre pausa real do banco,
exit1 e recuperação. Os resultados distribuídos/E2E/Docker são do executor;
não se atribuem ao revisor. A revisão não é prova universal de ausência de races.

O primeiro teste de referência rejeitada modificava o valor da original,
corretamente produzindo INCOMPATIBLE_REFERENCE; fixture corrigida para manter
valor e provocar rejeição de saldo. A primeira execução Docker de timeout mostrou
transaction_timeout igual ao statement encerrando conexão antes do rollback e
pool sem fechar até deadline. Margem explícita e budgets corrigidos; reexecução
SQL/Docker passou. Checks não foram relaxados nem testes anteriores removidos.

## Inventário

Criados:

Estado final: **31 arquivos modificados e 19 novos**, sem commit/push; HEAD e a
branch anterior permanecem no commit da Task 10 citado acima.

- Aplicação: process-wager.ts compartilhado e resolve-pending-wager.use-case.ts.
- Contrato: public/pending.ts; adapter SQL mikro-orm-pending.repository.ts;
  adapters/worker/pending-config.ts e pending-reference-worker.ts.
- Bootstrap: pending-worker.module.ts, run-pending-worker.ts e main.pending-worker.ts.
- Migration202610290002.ts.
- Cinco suítes test/pending-{worker,persistence,distributed,pipeline,docker}.test.ts;
  support/pending.ts e support/pending-process.ts. Reutilizado wager-child.ts.
- Esta documentação e pending-reference-worker.md.

Alterados: ProcessWagerUseCase, portas de persistência Wagering,
MikroOrmIdempotencyRepository, mapper Wagering, composição UnitOfWork, models e
registro de migrations; package.json/.env.example; exceção localizada do
entrypoint em Dependency Cruiser e guardas negativos ESLint/arquitetura.
Expectativas de migrations/testes anteriores foram atualizadas sem enfraquecer
cenários; consultas sobre schema antigo usam SQL até reaplicar os novos campos.
README, ARCHITECTURE, requisitos, domínios, persistência, HTTP, operação
consumer/publisher e instruções locais refletem a entrega. Nenhuma dependência,
lockfile, regra monetária ou migration histórica foi alterada.

## Limites e próxima etapa

Sem AWS gerenciada/IAM, carga, autenticação, dashboards, métricas agregadas,
reprocessamento manual HTTP, worker health HTTP ou novas operações. FAILED
continua reservado à classificação permanente explícita. TTL é política local
configurável; mudança do parâmetro recalcula a idade sobre created_at histórico,
portanto deve ser coordenada operacionalmente. Não há renovação de lease;
trabalho que exceder seu prazo reverte e aguarda recuperação.

O banco protege invariantes e serializa hot wallets; testes não prometem ausência
de todo deadlock em clientes SQL que ignorem a ordem. Outbox/FIFO mantêm entrega
at-least-once, sem exatamente uma entrega nem ordem global de commit. A próxima
etapa recomendada é completar observabilidade operacional do §12, conforme
prioridade aprovada, e integração downstream compatível com duplicatas.
