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

Cada processo tem pool e ciclo de vida próprios. A API não inicia workers.
O [Compose de demonstração](compose.demo.yaml) usa a mesma imagem compilada para
os quatro. Um job com a CLI MikroORM aplica migrations depois do healthcheck SQL;
outro provisiona as filas depois do healthcheck SQS. Processos dependentes esperam
esses jobs concluírem com sucesso. Runtime não inclui a CLI nem migra no startup.
O Compose original continua atendendo desenvolvimento e harnesses isolados.
[Operação local](docs/operations/local-development.md) e [demo](docs/quickstart.md).

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

MikroORM fornece EntityManager transacional, forks isolados e locks por registro
no PostgreSQL. Tipos do ORM ficam nos adapters/Platform. Testes de CLI, HTTP e
Docker exercitam a compatibilidade com Bun.

Money usa `bigint` em unidades de 1/100; strings preservam os centavos no ORM e
nos contratos JSON. SQL usa NUMERIC sem typmod, com CHECK de escala que rejeita
excesso em vez de arredondar. Não há teto comercial adicional; os limites técnicos
do PostgreSQL permanecem. [Contrato Financial](docs/domain/financial.md).

`FOR UPDATE` por wallet serializa decisões sobre o mesmo saldo. READ COMMITTED
observa o estado após a espera, e a comparação de versão na escrita protege
contra uso incorreto do adapter. Wallets distintas avançam em paralelo; uma
wallet muito disputada limita throughput. Reconciliação usa REPEATABLE READ
READ ONLY para ler saldo e ledger no mesmo snapshot, sem bloquear escritores,
mas ainda carrega o histórico completo em memória.

Financial grava OPENING no armazenamento compartilhado por sua própria porta,
sem importar Wagering. Abertura positiva começa na versão 1. Inbox e Outbox
persistentes sustentam idempotência e atomicidade no banco; o broker continua
at-least-once, sem transação distribuída PostgreSQL/SQS. Claims expiram após
falha do processo. Token e lease permitem fencing contra finalização pelo dono
antigo, mas não impedem duplicata de um envio já aceito pelo broker.

Terminais têm proteção SQL. RE-03 distingue unicidade histórica por modalidade
de compensação direta ativa da BET: após neutralizar REFUND por ROLLBACK,
a modalidade ROLLBACK ainda inédita pode compensar a BET. A política aprovada,
suas condições e a evolução da Task 12.1 estão em
[Wagering](docs/domain/wagering.md#políticas-e-reversões).

Autenticação foi omitida conforme o §2.
[NoAuthGuard](src/bootstrap/no-auth.guard.ts) é o ponto de substituição por guard
OIDC com validação de issuer/audience/claims e vínculo do provider. Health continua
aberto; SQS é canal interno com validação de domínio. Não há IdP entregue.

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
