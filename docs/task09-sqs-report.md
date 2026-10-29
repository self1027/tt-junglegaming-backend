# Task 09 — SQS FIFO, Inbox e consumer confiável

## Resultado e Git

Branch: **feat/sqs-inbox-consumer**, criada de feat/http-api no commit
`f214f1f10e316317fb9d7a5bdff76bc04c807743`. Checkout inicialmente limpo;
referências local, origin/feat/http-api e ls-remote eram iguais. Task 08 preservada
como ancestral. Não houve merge, reset, clean ou alteração de branch preexistente.
Durante a execução o usuário autorizou explicitamente commits e envio ao remote,
com no máximo 500 linhas alteradas por commit, sem novas perguntas. O envio
autorizado é dessa branch ao origin, sem merge na main.

Consumer executável independente em [main.consumer.ts](../src/main.consumer.ts),
sem listener HTTP, sobre o mesmo ProcessWagerUseCase da API. [Operação e comandos](sqs-consumer.md),
[contrato Messaging](domain/messaging.md#task-09--protocolo-de-recepção-implementado),
[plano/checkpoints](superpowers/plans/2026-10-29-sqs-inbox-consumer.md).

## Implementação e contratos

- SDK v3 modular @aws-sdk/client-sqs 3.1159.0, versão exata/lockfile. Configuração
  por ambiente e credenciais pela cadeia padrão; endpoint opcional em produção.
- Compose preserva PostgreSQL 18.3 e adiciona LocalStack 4.14.0 por perfil sqs,
  ambos por digest. Provisionamento explícito FIFO/DLQ/redrive/byQueue, sem
  criação de filas no startup, nomes globais ou volume de emulador compartilhado.
- Envelope original preservado, allowlists runtime, Money compartilhado, Unicode
  bem formado e OPENING proibido. Metadados AWS ficam fora da aplicação/domínio.
- Inbox usa consumerName wagering-v1 e messageId do envelope. Hash canônico próprio
  inclui timestamp/key/wallet; MessageId nativo é diagnóstico. Idempotência
  financeira e seu hash permanecem independentes e compatíveis com HTTP.
- Porta claim/complete e adapter MikroORM reutilizam tabela e TransactionSession.
  Ordem Inbox → idempotência → identidade externa → wallet → referência/histórico.
  Claim desaparece com rollback/crash; sem lease órfão nem transação aninhada.
- Inbox PROCESSED confirma junto com Wagering/idempotência/ledger/Outbox; inclui
  rejeições e pendências duráveis. Duplicata concluída retorna antes de efeitos.
  HTTP mantém execute(command); SQS usa participação opcional de Inbox.
- DeleteMessage só após Promise resolvida/commit. Falha de ACK tem diagnóstico
  próprio e redelivery seguro; não vira falha financeira ou novo evento.
- Uma mensagem por ReceiveMessage, com pollers concorrentes limitados. Isso
  preserva tentativas de sucessoras de uma mensagem inválida no mesmo grupo.
  FIFO otimiza ordem por wallet; locks SQL protegem inclusive agrupamento incorreto.
- Extensões de visibility finitas; limite de processamento também impede ACK
  tardio. statement_timeout/transaction_timeout aplicados ao consumer no PostgreSQL.
  ReceiveMessage tem cancelamento/deadline explícitos, não só timeout do handler SDK.
- JSON/envelope inválido/conflito permanente seguem redrive nativa sem ACK;
  rejeições de negócio confirmadas recebem ACK. Erros técnicos revertem e são
  reenviados com backoff limitado; uma indisponibilidade longa pode levar à DLQ.
- SIGTERM/SIGINT cancelam polling e drenam trabalhos iniciados; prazo excedido
  termina com 1 sem ACK incompleto. Caminho normal fecha SDK/pool. Outro processo
  recupera após desconexão/visibility; SIGKILL não promete hooks ou conclusão.
- Readiness usa SELECT 1 e GetQueueAttributes sem consumir/apagar: verifica FIFO,
  ARN da DLQ, maxReceiveCount e permissão de redrive. API: 200 saudável, 503
  ausente/indisponível; liveness independente. Consumer usa diagnósticos de processo.

Nenhuma migration criada; migrations históricas e challenge.md preservados.
Outbox permanece PENDING, sem publisher ou novos eventos de replay. Não há
Pending Reference Worker ou reprocessamento agendado.

## Evidências executáveis

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.1, PostgreSQL 18.3
e LocalStack 4.14.0 em recursos descartáveis; smoke em containers Linux.

| Cenário                       | Evidência                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox transacional            | Claims concorrentes aplicam uma vez; falha de conclusão reverte Inbox, Wagering, idempotência, saldo, ledger e Outbox                                                   |
| 100/80/80                     | Três processos; segundo observado em lock SQL enquanto o primeiro está antes de commit; outra wallet progride pelo terceiro; final 20.00, um débito, PROCESSED/REJECTED |
| 50 duplicatas                 | Três pools/processos, dois aguardando locks; 50 envelopes confirmados, uma operação financeira, um débito e dois eventos PENDING                                        |
| Crash antes do commit         | Sinal antes de commit, Inbox invisível, processo morto; efeitos revertidos; outro processo recebe e confirma uma vez                                                    |
| Crash após commit/antes ACK   | Sinal antes de DeleteMessage, estado confirmado inspecionado, processo morto; redelivery DUPLICATE, sem novos efeitos                                                   |
| ACK falho/visibility expirada | DeleteMessage injetado falha após commit; mesma mensagem reaparece. Expiração real com outro consumer aguardando Inbox também recupera                                  |
| HTTP ↔ SQS                    | Operação HTTP reapresentada por SQS e vice-versa; resposta histórica mantida após movimento posterior, sem ledger/Outbox extra                                          |
| Estados e operações           | BET/WIN/LOSS/REFUND/ROLLBACK, saldo insuficiente, referência ausente/em processamento/terminal; rejeições e pendências recebem ACK                                      |
| Dados inválidos/DLQ           | JSON, envelope, Money numérico, OPENING, Unicode e conflito Inbox; payload preservado na DLQ, sem efeitos; sucessoras válidas progridem com quatro pollers              |
| Indisponibilidade             | PostgreSQL parado e SQS pausado de verdade; readiness 503, liveness 200, sem confirmar falha técnica; redelivery/progresso após recuperação                             |
| Docker/SIGTERM                | Imagem reconstruída, API ready 200, consumer real esperando lock SQL recebe SIGTERM, conclui/ACK e sai 0                                                                |
| Prazo de shutdown             | SIGTERM sob lock mantido além do prazo; saída 1, Inbox/idempotência não confirmadas, nenhum ACK; outro container recupera, saldo 90.00                                  |

Todos os cenários financeiros conferem reconciliação do ledger com saldo
materializado, Wagering/idempotência/Inbox e contagens/status da Outbox.
Barreiras/sinais e pg_stat_activity comprovam contenção; não se usa sleep como
prova de corrida. O polling de observação tem prazo. Na execução integral:
100/80/80 usou PIDs **22108/21000/1248**; 50 duplicatas,
**8612/22896/21700**; crash antes de commit, **4604 → 22936**;
crash depois de commit, **22488 → 1696**, com receive count 3 nos dois casos.
Regressão HTTP iniciou servidores independentes **22984/11396/13988**.

## Revisão independente

Revisor separado em leitura encontrou dois defeitos. Testes novos reproduziram
ambos antes da correção: recebimento em batch podia gastar tentativas das
sucessoras sem execução; readiness aceitava DLQ denyAll. Recebimento unitário
com pollers concorrentes e validação de RedriveAllowPolicy corrigiram os casos.
O revisor releu as correções e não identificou novo defeito concreto; executou
10 testes unitários selecionados, zero falhas. Integração/Docker são evidências
do executor. A regressão FIFO real com quatro pollers também passou.

Durante testes de falha real, o timeout do request handler SDK não limitou o
polling com LocalStack pausado; cancelamento/deadline externo corrigiu o caso.
A configuração inicial transaction_timeout como propriedade solta era ignorada
pelo driver pg instalado; passou para parâmetro de conexão options, e o harness
confere os dois settings efetivos no PostgreSQL antes de sinalizar ready.

## Validação final

| Comando/check                      | Resultado                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| bun run typecheck                  | Passou                                                                                                               |
| bun run lint                       | Passou, incluindo arquitetura: 81 módulos/285 dependências, zero violações                                           |
| bun run test                       | **346 passaram, 0 falharam, 3.115 asserções, 23 arquivos, 235,42s**                                                  |
| bun run build                      | Passou                                                                                                               |
| Migrations reais                   | Up/status/down/up em PostgreSQL descartável e recusa de down com ledger; suíte anterior preservada                   |
| Docker build + smoke               | Passou; imagem distributed-wagering-processor:task09, API ready 200, consumer/SIGTERM saída 0                        |
| Prazo excedido/SIGTERM real        | Passou; saída 1 sem ACK/commit, recuperação por outro container com saída 0                                          |
| Graphify                           | Passou; 1.061 nós/2.614 relações; adapter Inbox localizado e caminho ConsumerModule → ProcessWagerUseCase confirmado |
| format:check, links e diff --check | Passaram; 317 links/âncoras locais conferidos em documentação alterada                                               |

Todas as 309 verificações anteriores permanecem na suíte; 37 testes novos.
Nenhuma asserção anterior foi removida ou enfraquecida. Testes de parser/config,
polling/ACK/visibilidade, Inbox, SQS real e resiliência são arquivos separados em
test/. Após teardown, docker ps não mostrou containers ativos da tarefa.

Graphify usa extração estrutural local, sem LLM/API. Seis arquivos não fornecem
símbolos individuais, incluindo main.consumer.ts e barrels; imports e conteúdo
foram conferidos diretamente. A consulta localizou porta/adapter/sessão/claim e
composição; o caminho confirmou reutilização do caso de uso. O grafo é auxiliar,
não prova atomicidade/arquitetura. Frontmatter de skills não mudou; documentos
humanos não exigem frontmatter. Enunciado e migrations históricas sem diff.

## Limitações e próxima etapa

Sem validação contra AWS gerenciada/IAM real ou teste de carga. LocalStack é
emulador descartável, não prova durabilidade do serviço gerenciado. Batch limitado
a um aumenta chamadas; concorrência por pollers/processos mantém paralelismo.
Receive count é aproximado e inclui entregas que não executaram o caso de uso.
Observabilidade tem logs seguros/latência, sem exporter/agregação de métricas;
readiness de atributos não prova permissões IAM de receber/apagar. Não há garantia
de exactly-once delivery nem prova universal contra clientes SQL que ignorem locks.

Próxima etapa recomendada: Outbox Publisher recuperável e, separadamente,
Pending Reference Worker, preservando eventos/identidades e a mesma coordenação.
Autenticação e métricas completas continuam trabalhos separados.

## Inventário completo

| Estado     | Arquivo                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modificado | [.dependency-cruiser.cjs](../.dependency-cruiser.cjs)                                                                                                 |
| Modificado | [.env.example](../.env.example)                                                                                                                       |
| Modificado | [AGENTS.md](../AGENTS.md)                                                                                                                             |
| Modificado | [ARCHITECTURE.md](../ARCHITECTURE.md)                                                                                                                 |
| Modificado | [README.md](../README.md)                                                                                                                             |
| Modificado | [bun.lock](../bun.lock)                                                                                                                               |
| Modificado | [compose.yaml](../compose.yaml)                                                                                                                       |
| Modificado | [docs/domain/messaging.md](../docs/domain/messaging.md)                                                                                               |
| Modificado | [docs/domain/wagering.md](../docs/domain/wagering.md)                                                                                                 |
| Modificado | [docs/http-api.md](../docs/http-api.md)                                                                                                               |
| Modificado | [docs/persistence.md](../docs/persistence.md)                                                                                                         |
| Modificado | [docs/requirements.md](../docs/requirements.md)                                                                                                       |
| Novo       | [docs/sqs-consumer.md](../docs/sqs-consumer.md)                                                                                                       |
| Novo       | [docs/superpowers/plans/2026-10-29-sqs-inbox-consumer.md](../docs/superpowers/plans/2026-10-29-sqs-inbox-consumer.md)                                 |
| Novo       | [docs/task09-sqs-report.md](../docs/task09-sqs-report.md)                                                                                             |
| Modificado | [eslint.config.mjs](../eslint.config.mjs)                                                                                                             |
| Modificado | [package.json](../package.json)                                                                                                                       |
| Modificado | [src/bootstrap/AGENTS.md](../src/bootstrap/AGENTS.md)                                                                                                 |
| Modificado | [src/bootstrap/api.module.ts](../src/bootstrap/api.module.ts)                                                                                         |
| Novo       | [src/bootstrap/consumer.module.ts](../src/bootstrap/consumer.module.ts)                                                                               |
| Modificado | [src/bootstrap/persistence.ts](../src/bootstrap/persistence.ts)                                                                                       |
| Modificado | [src/bootstrap/readiness.ts](../src/bootstrap/readiness.ts)                                                                                           |
| Novo       | [src/bootstrap/run-consumer.ts](../src/bootstrap/run-consumer.ts)                                                                                     |
| Novo       | [src/bootstrap/sqs.ts](../src/bootstrap/sqs.ts)                                                                                                       |
| Novo       | [src/main.consumer.ts](../src/main.consumer.ts)                                                                                                       |
| Novo       | [src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts](../src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts) |
| Novo       | [src/modules/wagering/adapters/sqs/wager-handler.ts](../src/modules/wagering/adapters/sqs/wager-handler.ts)                                           |
| Novo       | [src/modules/wagering/adapters/sqs/wager-message.ts](../src/modules/wagering/adapters/sqs/wager-message.ts)                                           |
| Modificado | [src/modules/wagering/application/process-wager.use-case.ts](../src/modules/wagering/application/process-wager.use-case.ts)                           |
| Novo       | [src/modules/wagering/public/inbox.ts](../src/modules/wagering/public/inbox.ts)                                                                       |
| Modificado | [src/modules/wagering/public/index.ts](../src/modules/wagering/public/index.ts)                                                                       |
| Modificado | [src/modules/wagering/public/persistence.ts](../src/modules/wagering/public/persistence.ts)                                                           |
| Modificado | [src/platform/messaging/AGENTS.md](../src/platform/messaging/AGENTS.md)                                                                               |
| Novo       | [src/platform/messaging/provision-sqs.ts](../src/platform/messaging/provision-sqs.ts)                                                                 |
| Novo       | [src/platform/messaging/reliable-consumer.ts](../src/platform/messaging/reliable-consumer.ts)                                                         |
| Novo       | [src/platform/messaging/sqs-config.ts](../src/platform/messaging/sqs-config.ts)                                                                       |
| Novo       | [src/platform/messaging/sqs-transport.ts](../src/platform/messaging/sqs-transport.ts)                                                                 |
| Novo       | [src/platform/messaging/transport.ts](../src/platform/messaging/transport.ts)                                                                         |
| Modificado | [src/platform/observability/AGENTS.md](../src/platform/observability/AGENTS.md)                                                                       |
| Modificado | [src/platform/observability/health.controller.ts](../src/platform/observability/health.controller.ts)                                                 |
| Modificado | [src/platform/observability/readiness.ts](../src/platform/observability/readiness.ts)                                                                 |
| Modificado | [test/architecture.test.ts](../test/architecture.test.ts)                                                                                             |
| Novo       | [test/consumer-docker.test.ts](../test/consumer-docker.test.ts)                                                                                       |
| Novo       | [test/consumer.test.ts](../test/consumer.test.ts)                                                                                                     |
| Novo       | [test/inbox.test.ts](../test/inbox.test.ts)                                                                                                           |
| Novo       | [test/sqs-consumer.test.ts](../test/sqs-consumer.test.ts)                                                                                             |
| Novo       | [test/sqs-input.test.ts](../test/sqs-input.test.ts)                                                                                                   |
| Novo       | [test/sqs.test.ts](../test/sqs.test.ts)                                                                                                               |
| Novo       | [test/support/consumer-child.ts](../test/support/consumer-child.ts)                                                                                   |
| Novo       | [test/support/consumer-process.ts](../test/support/consumer-process.ts)                                                                               |
| Modificado | [test/support/postgres.ts](../test/support/postgres.ts)                                                                                               |
| Novo       | [test/support/sqs.ts](../test/support/sqs.ts)                                                                                                         |
