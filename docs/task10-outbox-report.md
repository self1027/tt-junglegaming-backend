# Task 10 — Outbox Publisher e recuperação

## Resultado e Git

Branch **feat/outbox-publisher**, criada de feat/sqs-inbox-consumer no commit
`2f2c19608995bb4873baa69f6f4526a62cf06a51`. Checkout inicial limpo; local,
origin/feat/sqs-inbox-consumer e `git ls-remote` apontavam para esse mesmo commit.
Task 09 preservada como ancestral e sem alteração da branch anterior. Não houve
merge, rebase, reset, clean, exclusão de branches, commit ou push nesta tarefa.
As alterações da Task 10 permanecem no working tree para revisão do usuário.
Estado final: 21 arquivos modificados e 20 novos; HEAD e a branch da Task 09
continuam no commit acima. Nenhum artefato temporário de validação foi mantido.

Publisher Nest independente em [main.publisher.ts](../src/main.publisher.ts),
sem HTTP, com pool e SDK próprios. [Operação](outbox-publisher.md),
[contrato principal](domain/messaging.md#task-10--publicação-recuperável),
[decisão estrutural](../ARCHITECTURE.md#task-10--publisher-independente) e
[persistência](persistence.md#task-10--aquisição-e-confirmação-da-outbox).

## Entrega e contratos

- OutboxStore técnico com claim/published/retry/diagnostics; EventPublisher com
  publish/check/close, sem AWS/ORM nos contratos. Platform permanece sem importar
  módulos. Adapter SQS em Wagering conhece os eventos públicos existentes.
- Migration incremental **Migration202610290001**: claim_token, claimed_by,
  claimed_until, CHECK de coerência e trigger de histórico imutável/PUBLISHED
  irreversível. Índice parcial de vencimento existente reutilizado. Migrations
  anteriores e docs/challenge.md preservados; sem novas dependências/lockfile.
- Aquisição READ COMMITTED curta com CTE, FOR UPDATE SKIP LOCKED e UPDATE;
  token UUID novo por registro e attempts incrementado por claim confirmado.
  Commit libera locks antes da rede; não se estende a UnitOfWork financeira.
- Lease finito, sem renovação órfã. SDK executa uma tentativa limitada por timeout
  total. Batch <= concorrência e lease >= envio + 2 × SQL + margem de 1000ms.
- Finalização/retry condicionados a eventId/token/PENDING/lease válido; zero
  linhas resulta em diagnóstico do estado atual. Dono obsoleto não sobrescreve,
  reagenda ou libera o claim novo. PUBLISHED deixa de ser elegível.
- Envio de fatos históricos: quatro eventos v1, sem consulta ao saldo atual,
  reconstrução de operações ou nova identidade. Validação reutiliza factories,
  compara envelope completo/metadados e serializa o original com chaves ordenadas.
  Money permanece string decimal, inclusive acima de 53 bits.
- O original e os contratos entregues usam **version/data** no envelope. A
  terminologia eventVersion/payload do pedido não renomeia o contrato v1; as
  colunas técnicas continuam event_version e payload (envelope completo).
- Fila de saída **wager-events.fifo**, distinta de comandos/DLQ; provisionamento
  explícito reutiliza LocalStack/SDK. Retenção local de 14 dias e dedup explícita.
  API/consumer não publicam nem provisionam no startup. Compose preserva seu
  padrão de infraestrutura; execução separada da aplicação está documentada.
- Dedup ID = eventId e grupo = data.walletId, presentes nos quatro eventos.
  FIFO oferece ordem de chegada por grupo. O desafio não exige ordem de commit
  financeiro na saída e a implementação não a promete; sem sequência global.
- Retry ilimitado com backoff exponencial limitado/jitter. Erros permanentes
  aguardam o máximo; permanecem PENDING, auditáveis e recuperáveis, sem descarte
  ou estado terminal. last_error só recebe código permitido. Falha SQL depois
  do aceite SQS deixa o lease recuperável e admite republicação do mesmo evento.
- SIGTERM/SIGINT param novas aquisições/envios, drenam trabalho iniciado e fecham
  SDK/pool. Prazo excedido sai 1; outro processo recupera lease. SIGKILL não
  depende de hooks. Liveness/readiness da API não passam a depender da saída.
- Logs JSON seguros e diagnóstico SQL/SQS/loop, contagem PENDING, expirados/lag
  e contadores locais de publicação/retry. Sem payload financeiro, credenciais
  ou stack trace sensível; métricas agregadas continuam futuras.

Fluxo de confirmação: commit financeiro/Outbox PENDING → claim confirmado →
SendMessage aceito → UPDATE condicional PUBLISHED/published_at. Aceite SQS e SQL
são etapas independentes. A janela entre elas permite duplicatas at-least-once;
cinco minutos de deduplicação FIFO não garantem exactly-once delivery.

## Evidências executáveis

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.0, PostgreSQL 18.3 e
LocalStack 4.14.0 pinados no Compose; containers Linux. Recursos de testes usam
projetos/portas próprios, teardown e pools independentes.

| Cenário                       | Evidência                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quatro envelopes v1           | Comparação integral JSONB/mensagem recebida, version/data, IDs, correlação, causação quando presente, ocorrência, precisão e ausência de mutação                     |
| Migration                     | Down/status/up preserva PENDING/PUBLISHED legados; suíte de fundação também executa up/status/down/up e recusa apagar ledger confirmado                              |
| Claims SQL                    | Duas conexões/pools, lote limitado, due time, exclusão de lease válido e SKIP LOCKED sobre linha efetivamente bloqueada                                              |
| Índice                        | EXPLAIN real comprova Index Cond em next_attempt_at <= statement_timestamp(); evita varredura de todo backlog futuro                                                 |
| Fencing                       | Token novo com mesmo owner, lease expirado, sucesso/falha antigos recusados, conclusão duplicada sem alteração e PUBLISHED inelegível                                |
| Três publishers               | Três processos Bun parados em barreiras antes de SendMessage, três claims distintos simultâneos, depois nove eventos publicados                                      |
| Ausência de lock durante rede | pg_stat_activity sem idle in transaction; conexão observadora adquire FOR UPDATE NOWAIT nas três linhas com envio suspenso                                           |
| Crash antes de enviar         | SIGKILL após claim durável; sucessor readquire após expiração e publica o envelope original com attempts = 2                                                         |
| Crash após enviar             | Mensagem recebida no broker antes de matar o publisher; Outbox ainda PENDING; sucessor republica mesma identidade e conclui                                          |
| Rede incerta                  | Proxy HTTP encaminha SendMessage real ao LocalStack e retém resposta; mensagem é observada no broker enquanto processo ainda espera; SIGKILL e recuperação posterior |
| SQL após aceite               | Falha de finalização injetada e PostgreSQL realmente parado após aceite; evento permanece recuperável e conclui após restauração/reinício                            |
| SQS indisponível              | LocalStack pausado durante envio; PENDING, erro sanitizado e next_attempt_at persistidos; retomada publica mesmo envelope                                            |
| Evento incompatível           | Registro não suportado permanece INVALID_EVENT/PENDING com retry, enquanto outro evento válido progride                                                              |
| Ponta a ponta                 | HTTP BET/WIN/rejeição/REFUND ausente e LOSS pelo consumer; sete eventos com quatro tipos; Inbox/idempotência/ledger/reconciliação conferidos                         |
| Replay                        | BET devolve saldo histórico 100.00 mesmo após WIN; nenhuma Outbox/mensagem adicional ou débito duplicado                                                             |
| Docker                        | Build real, HTTP BET → eventos FIFO; SIGTERM durante SendMessage drena e sai 0; prazo excedido sai 1 sem publicação falsa e outro container recupera                 |

Na execução selecionada de integração, os três publishers tiveram PIDs
**13492/3772/9580**. Recuperação antes do envio: **5532 → 2816**; após envio:
**3396 → 10128**; falha de confirmação SQL: **17108 → 11472**. Barreiras e estado
SQL/broker, não sleeps isolados, comprovam as janelas. Nesses três cenários os
registros terminaram PUBLISHED com attempts = 2 e envelope inalterado.
Na suíte completa, três publishers usaram PIDs **11768/4636/8708**; recuperações
antes de enviar **13576 → 10272**, após enviar **2776 → 4892**, e após falha SQL
**5752 → 6184**. Os mesmos estados/invariantes foram reconferidos.

## Validação consolidada

Validação consolidada em 2026-10-29. A suíte completa preservou os 346 testes
anteriores e acrescentou 42, sem falhas. Resultados selecionados e consolidados:

| Comando/check                                                            | Resultado                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| bun run typecheck                                                        | Passou                                                         |
| bun run lint                                                             | Passou; 93 módulos/328 dependências; zero violações            |
| bun test test/publisher.test.ts                                          | 19 passaram, 0 falharam, 84 asserções                          |
| bun test test/publisher-persistence.test.ts                              | 7 passaram, 0 falharam, 60 asserções; reconferido pelo revisor |
| bun test test/publisher-pipeline.test.ts test/publisher-recovery.test.ts | 9 passaram, 0 falharam, 107 asserções, 93,02s                  |
| bun test test/publisher-docker.test.ts                                   | 3 passaram, 0 falharam, 15 asserções, 37,47s                   |
| bun run build                                                            | Passou                                                         |

`bun run test`: **388 passaram, 0 falharam, 3.389 asserções, 28 arquivos, 378,46s**.
Inclui regressões HTTP, Inbox/consumer/DLQ, três processos de entrada e saída,
migrations reais e Docker build/smoke/SIGTERM de API, consumer e publisher.
`bun run format:check` e `git diff --check` passaram; 344 links/âncoras locais
conferidos em 13 documentos alterados/novos, UTF-8 e ausência de frontmatter
inesperado. Nenhuma skill foi alterada. Todos os containers/volumes descartáveis
da validação foram removidos; imagens locais de smoke permanecem disponíveis.

Graphify foi consultado antes da exploração; o índice inicialmente desatualizado
foi atualizado antes de localizar Outbox/SQS. Atualização final: **1.202 nós e
3.070 relações**, sem LLM/API. `graph:query OutboxPublisher` localizou portas,
loop, adapter SQL/SQS e composição; `graph:path PublisherModule MikroOrmOutboxStore`
confirmou o caminho estrutural da composição. Sete arquivos não fornecem símbolos
individuais, incluindo main.publisher.ts e barrels; entrypoint/imports foram
conferidos diretamente. O grafo é auxiliar e não prova garantias distribuídas.

Nenhum teste anterior foi removido ou enfraquecido. A expectativa do histórico de
migrations passou a incluir a nova migration. Guardas arquiteturais acrescentam
controle positivo localizado para main.publisher.ts e negativos para imports
indevidos e mutações financeiras no publisher. Configuração strict preservada.

O primeiro setup SQS excedeu o prazo enquanto baixava a imagem ainda ausente;
após download concluído, os recursos órfãos desse setup foram removidos e as
integrações passaram. Um primeiro teste Docker leu só stdout e não encontrou o
diagnóstico de deadline emitido em stderr; o harness passou a ler ambos e o
cenário completo de deadline/recuperação passou. Não se contam execuções falhas
como aprovação.

A divisão dos testes SQS em pipeline e recuperação introduziu duas falhas no
harness: os recursos eram capturados antes do beforeAll, e os hooks eram
registrados somente ao importar um módulo compartilhado em cache. Os nove
cenários passaram após criar um harness por arquivo e acessar os recursos
inicializados pelos getters da instância.

A reexecução completa isolou uma falha adicional (387 passaram, uma falhou): o
teardown do teste de drenagem escrevia no stdin já fechado pelo consumer, antes
de o pai observar seu exitCode, provocando EPIPE. O helper agora respeita o
evento closed e continua verificando o código de saída. O cenário de drenagem
passou isoladamente, incluindo close repetido antes do teardown automático.

## Revisão independente

Revisor separado, somente leitura, encontrou um defeito de desempenho: relógio
volátil no limite next_attempt_at impedia range indexado. Correção por
statement_timestamp() preserva relógio real nos leases/fencing; novo teste EXPLAIN
passou no PostgreSQL real. Revisor reexecutou os 19 unitários e os 7 testes SQL,
sem falhas, e não encontrou outro defeito concreto em publicação/fencing/retry/
shutdown ou limites arquiteturais. Também conferiu testes Docker, cenário SQL
após aceite e documentação operacional. Correções de Unicode/documentação foram
conferidas no acabamento; os resultados da suíte completa/Docker são do executor.

## Inventário

Criados:

- [Portas técnicas](../src/platform/messaging/outbox.ts),
  [loop/retry](../src/platform/messaging/outbox-publisher.ts),
  [configuração](../src/platform/messaging/publisher-config.ts) e
  [fábrica SDK compartilhada](../src/platform/messaging/sqs-client.ts).
- [Store SQL](../src/platform/persistence/mikro-orm-outbox-store.ts) e
  [migration](../src/platform/persistence/migrations/Migration202610290001.ts).
- [Validação/serialização](../src/modules/wagering/adapters/sqs/persisted-event.ts)
  e [adapter SQS](../src/modules/wagering/adapters/sqs/sqs-event-publisher.ts).
- [Módulo Nest](../src/bootstrap/publisher.module.ts),
  [ciclo de vida](../src/bootstrap/run-publisher.ts) e
  [entrypoint](../src/main.publisher.ts).
- [Unidade](../test/publisher.test.ts), [SQL](../test/publisher-persistence.test.ts),
  [pipeline SQS/distribuído](../test/publisher-pipeline.test.ts),
  [recuperação SQL/SQS](../test/publisher-recovery.test.ts),
  [Docker](../test/publisher-docker.test.ts),
  [fixtures](../test/support/outbox.ts), [controle de processo](../test/support/publisher-child.ts),
  [composição de falhas de teste](../test/support/publisher-process.ts) e
  [harness isolado](../test/support/publisher-sqs-suite.ts).
- [Operação](outbox-publisher.md) e este relatório.

Modificados:

- [.dependency-cruiser.cjs](../.dependency-cruiser.cjs),
  [eslint.config.mjs](../eslint.config.mjs), [package.json](../package.json) e
  [.env.example](../.env.example).
- [Models](../src/platform/persistence/models.ts),
  [registro de migrations](../src/platform/persistence/config.ts),
  [transport SQS](../src/platform/messaging/sqs-transport.ts) e
  [provisionamento](../src/platform/messaging/provision-sqs.ts).
- [Arquitetura negativa](../test/architecture.test.ts) e
  [fundação SQL](../test/persistence.test.ts).
- [Drenagem do consumer](../test/sqs-consumer.test.ts) e
  [teardown de processo](../test/support/consumer-child.ts).
- [AGENTS raiz](../AGENTS.md), [bootstrap](../src/bootstrap/AGENTS.md),
  [Messaging](../src/platform/messaging/AGENTS.md) e
  [Persistence](../src/platform/persistence/AGENTS.md).
- [README](../README.md), [arquitetura](../ARCHITECTURE.md),
  [requisitos](requirements.md), [Messaging](domain/messaging.md),
  [Wagering](domain/wagering.md), [persistência](persistence.md) e
  [operação de entrada](sqs-consumer.md).

## Limitações e próxima tarefa

Sem AWS gerenciada/IAM real, consumidor downstream, teste de carga ou métricas
agregadas/exportadas. LocalStack não prova durabilidade AWS; recriar seu ambiente
apaga mensagens já PUBLISHED, que não são reenviadas automaticamente. Retenção no
broker é finita. Fencing protege SQL, não impede envio externo tardio; duplicatas
e inversão da ordem de commit permanecem possíveis. INVALID_EVENT exige corrigir
causa/suporte contratual, sem editar silenciosamente fatos históricos. Tentativas
ilimitadas pressupõem monitorar backlog/erros e restaurar dependências.

Próxima tarefa recomendada: **Pending Reference Worker**, com aquisição/retry/TTL
e atualização condicionada dos resultados não terminais, independente do publisher.
Nenhuma regra financeira, Inbox/ACK, autenticação ou operação de referências foi
alterada/antecipada nesta entrega.
