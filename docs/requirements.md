# Requisitos e critérios de aceitação

## Fonte e classificação

[challenge.md](challenge.md) é o enunciado integral, primário e imutável, lido antes desta derivação. Este documento é um índice de cobertura; contratos detalhados ficam nos documentos especializados, sem substituir o original. As referências §n são os números das seções originais. **Explícito** é obrigação do desafio; **opcional** depende de escolha; **decisão aprovada** e **proposta pendente** pertencem a [ARCHITECTURE.md](../ARCHITECTURE.md).

## Cobertura do enunciado

| Fonte        | Natureza e requisito                                                                                                                                                                                                                                                 | Fonte especializada / evidência futura                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| §§1, 3       | Explícito: processar múltiplos provedores sob duplicatas, desordem, simultaneidade, crash antes/depois de commit e indisponibilidade PostgreSQL/SQS; sem efeitos duplicados, perda de eventos confirmados ou saldo negativo                                          | [Financial](domain/financial.md), [Wagering](domain/wagering.md), [Messaging](domain/messaging.md) e cenários abaixo |
| §2           | Opcional: autenticação; com IdP externo se implementada, sem cadastro artesanal de senhas; se omitida, documentar desenho e ponto de extensão em código. Health aberto; SQS interno confiável, identidade do provider validada no domínio                            | [Arquitetura](../ARCHITECTURE.md); omitida na Task 08 com guard no-op e desenho IdP                                  |
| §4           | Explícito: Bun 1.x como runtime/package manager/test runner, TS strict, NestJS, PostgreSQL, SQS via LocalStack/MiniStack, Docker Compose, migrations versionadas/reversíveis; MikroORM preferencial ou TypeORM aceito, nenhum outro ORM                              | [Arquitetura](../ARCHITECTURE.md); ORM, mapeamento Money e estratégia transacional precisam de justificativa         |
| §5           | Explícito: sem dinheiro number/float/double, idempotência só em memória, dependência exclusiva do FIFO, publicação antes de commit, mutação/exclusão de ledger, lock global ou atualização de saldo sem concorrência; correção multi-instância e garantias no schema | [Financial](domain/financial.md), [Messaging](domain/messaging.md), [Arquitetura](../ARCHITECTURE.md)                |
| §6.0         | Explícito: estado encapsulado, construtor privado/protegido e factories estáticas; rehydrate reconstrói persistido sem revalidar transições; nomes/assinaturas dos esqueletos são adaptáveis                                                                         | Documentos de domínio                                                                                                |
| §§6.1–6.2    | Explícito: Money exato, imutável, escala 2, contratos string/ISO-4217, validação de entradas/moedas; wallet única por player/moeda, saldo/ledger consistentes, sem lost update e versionamento condicionado à mudança de saldo                                       | [Financial](domain/financial.md)                                                                                     |
| §6.3         | Explícito: tipos/estados, OPENING interno, terminais imutáveis e conflito de payload                                                                                                                                                                                 | [Wagering](domain/wagering.md)                                                                                       |
| §6.4         | Explícito: ledger estruturalmente imutável, aritmética validada, no máximo uma entrada por transação/wallet, sem lançamento para LOSS/rejeição; partidas dobradas opcionais                                                                                          | [Financial](domain/financial.md)                                                                                     |
| §6.5         | Explícito: Inbox/Outbox persistentes e atomicidade SQL com saldo/ledger                                                                                                                                                                                              | [Messaging](domain/messaging.md)                                                                                     |
| §§7, 7.1–7.2 | Explícito: operações, referências, reversões integrais, replay original, pendências reprocessadas com backoff exponencial e limite/TTL justificado; rejeição com código estável, inclusive expiração e reversão sem saldo distinguida                                | [Wagering](domain/wagering.md)                                                                                       |
| §8           | Explícito: concorrência por wallet, wallets distintas paralelas, três ou mais instâncias e cenário 100/80/80                                                                                                                                                         | Aceitação abaixo; estratégia justificada em [Arquitetura](../ARCHITECTURE.md)                                        |
| §9           | Explícito: abertura, consultas, submissão, header/hash/replay, reconciliação, health; status HTTP devem diferenciar as categorias descritas, mapeamento implementado na Task 08                                                                                      | Contratos HTTP abaixo                                                                                                |
| §10          | Explícito: filas nomeadas, envelope de entrada, mesmo use case HTTP/SQS, Inbox, ACK após commit, classificação de erros, retry/DLQ limitados e SIGTERM seguro                                                                                                        | [Messaging](domain/messaging.md)                                                                                     |
| §11          | Explícito: Outbox atômica, publicação recuperável entre instâncias, duplicatas seguras, eventos mínimos e envelope por classes                                                                                                                                       | [Messaging](domain/messaging.md)                                                                                     |
| §12          | Explícito: logs JSON correlacionados sem dados sensíveis/payload financeiro completo; métricas e health separados. OpenTelemetry/dashboard opcionais                                                                                                                 | Observabilidade abaixo                                                                                               |
| §13          | Explícito: unidade, integração com serviços reais em containers, paralelismo real e reconciliação final                                                                                                                                                              | Aceitação abaixo                                                                                                     |
| §14          | Explícito: README com setup/comandos; ARCHITECTURE com decisões/trade-offs/limitações; avaliação e falhas eliminatórias abaixo. Carga opcional, sem meta de RPS                                                                                                      | Entrega e avaliação abaixo                                                                                           |

## Contratos HTTP (§9)

A Task 08 implementa estes contratos, com detalhe em [HTTP](http-api.md). A Task 09 completa readiness com verificação real PostgreSQL/SQS/FIFO/redrive/DLQ; ausência/indisponibilidade retorna 503. Autenticação foi omitida com ponto de extensão no-op, conforme §2.

| Endpoint                                                                  | Contrato explícito                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | Entrada playerId/initialBalance MoneyProps; saída id/playerId/balance/version. Inicial positivo gera OPENING + CREDIT na mesma transação SQL; version começa em 1. Duplicata playerId/moeda é conflito. Detalhes em [Financial](domain/financial.md)                                                                |
| `GET /wallets/:walletId`                                                  | Consulta wallet                                                                                                                                                                                                                                                                                                     |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50`                       | Cursor estável e opaco; 50 é o exemplo do enunciado, não define limite máximo/default                                                                                                                                                                                                                               |
| `GET /wagering/transactions/:transactionId`                               | Consulta por identificador interno                                                                                                                                                                                                                                                                                  |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por provider e identificador externo                                                                                                                                                                                                                                                                       |
| `POST /wagering/transactions`                                             | Idempotency-Key obrigatório e fonte da verdade; body providerId/externalTransactionId/playerId/walletId/roundId/gameId/kind/money e referenceExternalTransactionId quando exigido. Resposta ilustrada contém transactionId/status/balance/idempotentReplay; regras de replay/hash em [Wagering](domain/wagering.md) |
| `POST /wallets/:walletId/reconciliation`                                  | walletId/storedBalance/calculatedBalance/difference/consistent/checkedEntries; divergência em resposta/log/métrica, sem correção silenciosa                                                                                                                                                                         |
| `GET /health/live`                                                        | Processo vivo; sem autenticação                                                                                                                                                                                                                                                                                     |
| `GET /health/ready`                                                       | PostgreSQL e SQS alcançáveis; sem autenticação                                                                                                                                                                                                                                                                      |

HTTP diferencia payload inválido (400), conflito (409), rejeição persistida de negócio (422), processado (200), aceite pendente (202), ausência (404), falha transitória classificável (503) e inesperada (500). Abertura retorna 201. Códigos são escolhas locais da Task 08; failure codes de negócio permanecem em [Wagering](domain/wagering.md). UUIDs/valores dos exemplos não impõem formato geral de IDs externos ou limites monetários não declarados.

Evidências da Task 08: [HTTP/PostgreSQL real](../test/http-api.test.ts), [três processos HTTP](../test/http-concurrency.test.ts), [casos de uso Financial](../test/wallet-use-cases.test.ts), [validação runtime](../test/http-input.test.ts) e [relatório](task08-http-report.md). Incluem abertura zero/positiva/rollback/concorrência, versão 1, idempotência/replay histórico, consultas/cursor com microssegundos, reconciliação exata sem escrita e snapshot durante commit concorrente. Diagnóstico de divergências registra log e contador por instância; exportação/agregação de métricas e observabilidade completa seguem pendentes.

## Observabilidade (§§9, 12)

Logs estruturados JSON com correlationId, messageId, transactionId, walletId e providerId; sem segredos, dados sensíveis ou payloads financeiros completos. Correlação entre transportes/processos deve permitir diagnóstico baseado em evidências; não inventar identificadores inexistentes em um fluxo.

Métricas mínimas: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de processamento. Divergências de reconciliação também devem ser contabilizadas (§9). Liveness/readiness têm responsabilidades distintas. OpenTelemetry e dashboard são opcionais.

## Aceitação obrigatória (§§8, 13)

Estas são obrigações do desafio, **não resultados dos testes de bootstrap**. A cobertura implementada pelas Tasks 06 e 07 e as responsabilidades futuras estão rastreadas ao final deste índice.

| Grupo                 | Cenários e evidências exigidos                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unidade               | Operações e validações Money (escala, arredondamento e entradas inválidas), invariantes Wallet, BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda e key com payload divergente                            |
| Integração real       | PostgreSQL e LocalStack/MiniStack em containers: migrations/constraints; atomicidade wallet/ledger/Inbox/Outbox; Inbox/redelivery; publishers concorrentes; retry/DLQ; recuperação após reinicialização |
| Duplicatas            | Mesma aposta 50 vezes em paralelo produz um único débito                                                                                                                                                |
| Disputa de saldo (§8) | Inicial 100.00 BRL, duas BET de 80.00 BRL simultâneas: exatamente uma PROCESSED, outra REJECTED por insuficiência, final 20.00 BRL, exatamente um débito no ledger, retries sem débito extra            |
| Paralelismo           | Wallets distintas em paralelo e pelo menos três processos/instâncias simultâneos; mocks sequenciais não comprovam a garantia                                                                            |
| Crash/ACK             | Matar worker depois de commit e antes de ACK; redelivery não duplica efeitos                                                                                                                            |
| Publicação            | Dois publishers sobre a mesma Outbox; commit seguido de crash antes da publicação é recuperado por outra instância (§11), duplicata segura                                                              |
| Desordem              | REFUND ou ROLLBACK antes da referência; persistência, reprocessamento e resolução ou rejeição auditável                                                                                                 |
| Reinício              | Reiniciar serviço e comprovar consistência final                                                                                                                                                        |

Invariante final de todos os testes financeiros: `wallet.balance == saldo reconstruído pelo ledger`. Cada teste pertinente deve evidenciar o saldo materializado e a reconstrução, incluindo OPENING. Atomicidade exige provar ausência de efeitos parciais em falhas, não apenas sucesso.

## Entrega e avaliação (§14)

| Área                    | Pontos |
| ----------------------- | ------ |
| Correção financeira     | 20     |
| Concorrência            | 20     |
| Idempotência            | 15     |
| Mensageria e falhas     | 15     |
| Modelagem e arquitetura | 10     |
| Testes                  | 10     |
| Observabilidade         | 5      |
| Documentação            | 5      |

Falhas eliminatórias: dinheiro number; saldo negativo por race; débito/crédito duplicado; idempotência só em memória; correção somente em uma instância; publicação antes do commit; ausência de ledger auditável; substituir completamente PostgreSQL/SQS por mocks.

Carga é opcional. Se implementada, expor `bun run test:load` e registrar ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag; nenhuma meta de RPS é imposta. Esse script **não existe atualmente**. Setup/comandos ficam no [README](../README.md); trade-offs, limitações e escolhas em [ARCHITECTURE](../ARCHITECTURE.md).

## Divergências e definições em aberto

Não há autorização para alterar o enunciado. A implementação atual cobre bootstrap, [persistência](persistence.md), [Financial](domain/financial.md), [Wagering](domain/wagering.md) e ProcessWagerUseCase. A [Task 06](persistence.md#task-06--processamento-atômico) acrescenta evidências para §§5–8 e 13: idempotência persistente, canonicalização/hash, replay histórico, processamento atômico, reversões, pendências e três processos Bun independentes. [Testes do processador](../test/process-wager-persistence.test.ts) cobrem 50 duplicatas, 100/80/80, wallets paralelas e recuperação antes/depois de commit. [Portas SQL](../test/wagering-persistence.test.ts) comprovam estados e migration adicional. A [Task 07](task07-outbox-report.md) acrescenta eventos tipados/versionados e Outbox atômica (§§6.5 e 11), rollback e durabilidade após crash, ampliando as mesmas evidências multi-processo (§13) sem publicar. As políticas locais aprovadas complementam o desafio sem alterá-lo. A Task 08 entrega endpoints (§9), abertura, consultas e reconciliação com snapshot e concorrência HTTP real; readiness completo depende de SQS. A Task 09 entrega Inbox/SQS/ACK/DLQ (§10), atomicidade (§6.5), concorrência/recuperação (§§8, 13) e readiness PostgreSQL/SQS (§9), com [operação](sqs-consumer.md) e [evidências](task09-sqs-report.md). Publicação (§11) está entregue na Task 10; reprocessamento agendado (§7.1) está entregue na Task 11; observabilidade completa (§12) continua futura; não se anuncia aceitação distribuída completa do desafio. A [política de testes](../test/AGENTS.md) permanece em `test/`.

## Task 11 — recuperação de referências (§§5–8, 11, 13)

[Contrato principal](domain/wagering.md#task-11--resolução-de-referências),
[operação](pending-reference-worker.md) e [relatório](task11-pending-report.md).

| Critério                                                          | Evidência executável                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| PENDING_REFERENCE/PENDING, referência atual, TTL/backoff          | [Unidade](../test/pending-worker.test.ts) e [PostgreSQL](../test/pending-persistence.test.ts)                |
| Claims, SKIP LOCKED, índice, leases/fencing, migration reversível | PostgreSQL real, EXPLAIN, up/status/down/up e estados legados                                                |
| Mesma identidade/motor, snapshot terminal, eventos atômicos       | Rollback em wallet/ledger/Wager/idempotência/dois eventos/finalização, histórico e precisão acima de 53 bits |
| Três processos, crashes, reversões, wallets independentes         | [Distribuídos](../test/pending-distributed.test.ts), barreiras stdin/pg_stat_activity, reconciliação         |
| Replay HTTP/SQS durante resolução e saída FIFO                    | [Pipeline real](../test/pending-pipeline.test.ts), consumer/Inbox/worker/publisher                           |
| Processo independente, timeout, SIGTERM/deadline e recuperação    | [Docker real](../test/pending-docker.test.ts), PostgreSQL pausado e sucessor                                 |

## Task 10 — cobertura de publicação (§§3, 5, 6.5, 8, 11–13)

Publisher independente implementa saída at-least-once para os quatro eventos v1,
com identidade/envelope histórico preservados. Claims SQL concorrentes, leases
recuperáveis, fencing e retry sem descarte fecham o caminho Outbox → SQS FIFO.
[Contrato](domain/messaging.md#task-10--publicação-recuperável),
[operação](outbox-publisher.md), [relatório e resultados](task10-outbox-report.md).

| Critério                                                               | Evidência executável                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Publicar depois do commit/sem dual write ou transação SQL durante rede | PostgreSQL/SQS reais e observação pg_stat_activity/lock NOWAIT em [publisher-pipeline.test.ts](../test/publisher-pipeline.test.ts) |
| Claims exclusivos, leases e fencing de proprietário obsoleto           | [SQL/constraints/EXPLAIN](../test/publisher-persistence.test.ts) e três processos independentes                                    |
| Identidade/precisão/contratos e retry estáveis                         | [Unidade](../test/publisher.test.ts), HTTP/consumer → Outbox → SQS, quatro eventos e replay financeiro                             |
| Crash antes/durante/depois do envio, SQL incerto                       | SIGKILL, barreiras de portas reais, proxy retendo resposta SQS, PostgreSQL/SQS indisponíveis                                       |
| SIGTERM/drenagem/prazo e reinício                                      | [Imagem Docker e sinais reais](../test/publisher-docker.test.ts)                                                                   |
| Ordenação e deduplicação declaradas                                    | Grupo walletId e dedup eventId verificados no broker; sem promessa de ordem de commit ou exactly-once                              |
| Arquitetura preservada                                                 | [Testes negativos](../test/architecture.test.ts), lint/Dependency Cruiser, sem AWS em domínio ou Platform → módulos                |

Worker de referências, processamento posterior de PENDING_REFERENCE/PENDING e TTL estão entregues na Task 11 acima. Métricas agregadas continuam pendentes. Histórico de Tasks anteriores registra a cobertura
na data de cada entrega e não substitui a implementação/evidência atual.
