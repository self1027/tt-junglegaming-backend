# Arquitetura do Distributed Wagering Processor

O sistema é um monólito modular hexagonal com quatro processos NestJS/Bun que
compartilham PostgreSQL: API, consumer SQS, publisher Outbox e worker de referências.
O [enunciado](docs/challenge.md) define os requisitos; a
[matriz](docs/requirements.md) registra sua cobertura e a política de reversões.

## Módulos e fronteiras

| Área      | Responsabilidade                                                      | Entrada pública                         |
| --------- | --------------------------------------------------------------------- | --------------------------------------- |
| Financial | Money, Wallet, ledger, abertura, consultas e reconciliação            | [public](src/modules/financial/public/) |
| Wagering  | Operações, estados, referências, idempotência, eventos e orquestração | [public](src/modules/wagering/public/)  |
| Platform  | Persistência, transporte, publicação e observabilidade técnicos       | [platform](src/platform/)               |
| Bootstrap | Composição concreta e ciclo de vida                                   | [bootstrap](src/bootstrap/)             |

Cada módulo tem `domain`, `application`, `public` e `adapters`. Domain depende de
domain/public; application usa contratos e domínio; public expõe contratos e
tipos de domínio. Essas camadas não importam frameworks ou pacotes externos.
Adapters implementam portas e traduzem protocolos. Financial é independente de
Wagering; Wagering acessa Financial somente por public. Platform não importa
módulos. Bootstrap compõe os adapters, sem decidir regras financeiras.

Controllers delegam a pipes/casos de uso. [ESLint](eslint.config.mjs) e
[dependency-cruiser](.dependency-cruiser.cjs) verificam fronteiras, imports
resolvidos, ciclos e dependências de produção. Testes negativos verificam as
regras; revisão humana ainda é necessária para avaliar semântica.

## Processos

| Entrypoint                                           | Dependências e trabalho                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [main.api.ts](src/main.api.ts)                       | HTTP; PostgreSQL no startup, SQS verificado em readiness; abertura, processamento e consultas |
| [main.consumer.ts](src/main.consumer.ts)             | PostgreSQL/SQS; recebe comandos, participa da Inbox e ACK após commit                         |
| [main.publisher.ts](src/main.publisher.ts)           | PostgreSQL/fila de eventos; publica Outbox confirmada                                         |
| [main.pending-worker.ts](src/main.pending-worker.ts) | Somente PostgreSQL; resolve operações existentes sem HTTP ou SQS                              |

Cada processo tem pool e ciclo de vida próprios. A API não inicia workers. Compose
fornece infraestrutura; processos podem ser executados pelo checkout ou pela
imagem compilada. [Operação local](docs/operations/local-development.md).

## Fronteiras de commit

`ProcessWagerUseCase` é compartilhado por HTTP e SQS. A
[composição](src/bootstrap/persistence.ts) fornece repositórios com a mesma
TransactionSession: Inbox quando aplicável, idempotência, WagerTransaction,
Wallet, ledger e inserção Outbox. A Promise retorna depois do commit; falha de
qualquer participante reverte todos. Não há envio SQS dentro dessa transação.

`CreateWalletUseCase` tem unidade própria para wallet, OPENING e ledger de abertura.
`ResolvePendingWagerUseCase` atualiza a entidade já existente, resultado idempotente,
saldo/ledger e novos fatos Outbox no mesmo commit. Ambos reutilizam o domínio
Financial. Colaboradores recebem o contexto existente; chamar `execute` novamente
abre outra transação e não estende a unidade anterior.

Publisher e worker confirmam claims em transações técnicas curtas. O publisher
libera locks antes da rede; o worker libera o claim antes de esperar locks
financeiros. Finalizações exigem token e lease válido no relógio PostgreSQL.
[Fluxos e janelas de falha](docs/architecture/data-flow.md) e
[ordem de locks](docs/architecture/concurrency.md).

## Decisões estruturais

Estas escolhas foram aprovadas nas entregas anteriores; a Task 12 acrescenta a
proteção SQL de terminais e a instrumentação requerida pelo enunciado. A Task 12.1
substitui a restrição histórica entre modalidades pela proteção de compensação
ativa aprovada em [Wagering](docs/domain/wagering.md#políticas-e-reversões).

| Escolha                                 | Motivo e consequência                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MikroORM/PostgreSQL                     | EntityManager transacional, forks isolados, locks por registro e migrations explícitas. Tipos do ORM ficam nos adapters/Platform. Compatibilidade Bun é exercitada por CLI, HTTP e Docker reais.                                                              |
| Money em bigint, SQL NUMERIC sem typmod | Unidades de 1/100 evitam erro binário; strings preservam centavos no ORM/JSON. CHECK de escala rejeita excesso em vez de arredondar. Sem teto comercial inventado; limites técnicos do PostgreSQL continuam existindo. [Financial](docs/domain/financial.md). |
| Lock pessimista por wallet              | FOR UPDATE serializa decisões do mesmo saldo. READ COMMITTED observa estado após espera; comparação de versão na escrita protege contra uso incorreto do adapter. Wallets diferentes avançam em paralelo. Hot wallet limita throughput.                       |
| Leitura REPEATABLE READ READ ONLY       | Reconciliação lê wallet e ledger no mesmo snapshot, sem bloquear escritores. O histórico completo ainda ocupa memória.                                                                                                                                        |
| OPENING no armazenamento compartilhado  | Financial grava registro interno por sua própria porta, sem importar Wagering. Abertura positiva começa na versão 1.                                                                                                                                          |
| Inbox e Outbox persistentes             | Banco sustenta idempotência e atomicidade; broker permanece at-least-once. Não há transação distribuída PostgreSQL/SQS.                                                                                                                                       |
| Claims com lease/token                  | Falha de processo libera trabalho por expiração; fencing impede finalização pelo dono antigo. Não impede envio duplicado já aceito pelo broker.                                                                                                               |
| IdP omitido                             | Permitido no §2. [NoAuthGuard](src/bootstrap/no-auth.guard.ts) é o ponto de substituição por guard OIDC com validação de issuer/audience/claims e vínculo do provider. Health continua aberto; SQS permanece canal interno com validação de domínio.          |

Migrations são a fonte das constraints e triggers; não há sincronização automática
de schema. A migration inicial recusa down quando existe ledger confirmado.
[Schema e integridade](docs/persistence.md). As políticas locais de zero,
reversões, TTL e replay pertencem a [Wagering](docs/domain/wagering.md).

## Garantias e limites

Efeitos financeiros são efetivamente únicos pelas identidades e coordenação no
banco. Isso exige usar os adapters/ordem de locks contratados. SQL administrativo
arbitrário pode violar relações que dependem da aplicação, como saldo versus soma
do ledger; privilégios que alterem schema podem remover proteções.

SQS não garante ordem de commit dos eventos publicados. Duplicatas após aceite e
antes de PUBLISHED são possíveis, inclusive além da janela FIFO. Não há consumer
downstream entregue, autenticação, double-entry, carga ou OpenTelemetry/dashboard.
FAILED existe no domínio/schema; erros técnicos genéricos não viram FAILED
automaticamente. Métricas JSON não são um ledger durável nem um backend agregado.

A [estratégia de testes](docs/testing/strategy.md), os
[cenários distribuídos](docs/testing/distributed-scenarios.md) e a
[matriz](docs/requirements.md) delimitam o que foi verificado. Planos e resultados
anteriores estão no [histórico](docs/history/README.md).
