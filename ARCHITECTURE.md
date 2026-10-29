# Arquitetura do Distributed Wagering Processor

## Status e autoridade

O [enunciado](docs/challenge.md) é a fonte imutável dos requisitos. O [índice de requisitos](docs/requirements.md) aponta seus contratos e critérios. Aqui ficam decisões estruturais; regras financeiras, operações e transporte ficam em [docs/domain](docs/domain/). **Aprovada** significa determinada pela tarefa de arquitetura/bootstrap; **obrigatória** vem do enunciado; **pendente/proposta** não autoriza implementação como contrato fechado.

Implementado: API NestJS em [src/main.api.ts](src/main.api.ts), composição em [src/bootstrap](src/bootstrap/), `GET /health/live`, fundação PostgreSQL/MikroORM, domínio [Financial](docs/domain/financial.md), domínio [Wagering](docs/domain/wagering.md) e ProcessWagerUseCase com idempotência persistente, processamento financeiro atômico e eventos tipados na Outbox. Não há endpoints financeiros, Inbox, publicação, SQS, consumer, worker, readiness ou reconciliação. Dockerfile preservado; [compose.yaml](compose.yaml) oferece PostgreSQL.

## Decisões aprovadas

- Monólito modular hexagonal, com processos escaláveis separadamente. NestJS, TypeScript strict, Bun 1.x, ESLint strict type-aware e Prettier com tabs/largura 4. Versões executáveis pertencem ao [package.json](package.json).
- Contexto segue a separação do material `../sam/`, capítulos 04–06: orientação como índice, contratos por domínio, procedimentos com entradas/etapas/evidências e validação proporcional. Exemplos didáticos daquele material não adicionam requisitos financeiros. As instruções operacionais são autossuficientes neste repositório.
- Graphify é o índice derivado de navegação do código, consultado antes de exploração ampla. Extração estrutural local (AST e títulos/links de documentos), sem LLM, e leitura dirigida das fontes preservam a autoridade do enunciado e dos contratos; o grafo não comprova invariantes. Setup, cobertura e atualização pertencem a [docs/tooling/graphify.md](docs/tooling/graphify.md).
- Distribuição de responsabilidades e dependências abaixo; fronteira transacional coordenada pela aplicação de Wagering. O contexto inclui os participantes entregues, inclusive Outbox desde a Task 07, sem antecipar Inbox.

| Escopo                              | Responsabilidade planejada                                     |
| ----------------------------------- | -------------------------------------------------------------- |
| [Financial](src/modules/financial/) | Money, wallet, movimentações, ledger, abertura e reconciliação |
| [Wagering](src/modules/wagering/)   | Operações, estados, referências, idempotência e orquestração   |
| [Platform](src/platform/)           | Mensageria, persistência e observabilidade técnicas            |
| [Bootstrap](src/bootstrap/)         | Composição concreta, inicialização e ciclo de vida             |

Cada módulo contém `domain`, `application`, `public` e `adapters`. `public` expõe contratos sem importar adapters. Domain não depende de frameworks; application depende de contratos, não implementações. Adapters implementam portas da aplicação. Financial não depende de Wagering; Wagering usa somente contratos públicos de Financial. Nenhum módulo acessa detalhes internos de outro. Platform não importa módulos; adapters dos módulos podem implementar suas portas usando recursos técnicos de Platform. Bootstrap compõe as implementações concretas; regras de negócio ficam fora dele e dos controllers.

As regras atuais em [.dependency-cruiser.cjs](.dependency-cruiser.cjs) e [eslint.config.mjs](eslint.config.mjs) reforçam essas fronteiras, inclusive imports de tipos e ciclos. As camadas internas atualmente também vedam imports de pacotes externos: isso precisa ser considerado ao propor uma biblioteca decimal, sem relaxar a regra silenciosamente. O grafo atual abre exceção apenas a `main.api.ts` para importar bootstrap; novos entrypoints precisarão de ajuste localizado e testes na futura implementação.

## Unidade transacional

`ProcessWagerUseCase`, em application de Wagering, coordena o processamento pela porta `UnitOfWork`. O contexto oferece repositórios associados **à mesma transação**, sem tipos do ORM nos contratos internos. Wagering estende o contexto financeiro público com WagerTransactionRepository e IdempotencyRepository. Financial não conhece essa extensão. [bootstrap/wagering.ts](src/bootstrap/wagering.ts) compõe o caso de uso sem lógica financeira e sem endpoints novos.

Na Task 06, a unidade atômica passou a abranger reserva/conclusão idempotente, WagerTransaction, wallet e ledger quando há mudança. A Task 07 inclui Outbox antes da conclusão idempotente. Uma única chamada a execute, sem retry interno; resposta somente após commit. A aplicação financeira participa do contexto recebido e **não abre transação independente**. Inbox deverá participar futuramente da mesma unidade.

### Task 07 — eventos e intenção durável

Contratos públicos de eventos Wagering e WalletBalanceChanged pertencem a Wagering,
que coordena os fatos confirmados. IntegrationEvent abstrato e quatro subclasses
v1 sem infraestrutura formam a união discriminada. A porta Outbox pertence ao
mesmo contrato público; o adapter do módulo usa somente a sessão e o modelo técnico
de Platform. Essa localização segue as fronteiras existentes sem Platform importar
negócios e sem exceções novas em ESLint/Dependency Cruiser. Financial permanece
independente de Wagering. [Protocolo e matriz](docs/domain/messaging.md#task-07--protocolo-v1-implementado).

Bootstrap compõe MikroOrmOutboxRepository com a mesma TransactionSession dos demais
adapters. Cada INSERT é imediato; o envelope completo vai no JSONB existente.
Nenhuma segunda Outbox ou migration foi necessária. Append falha junto com toda
a unidade financeira; replay retorna antes de construir eventos. Não há lock novo,
commit local ou publicação. Identidade, correlação, causação e evolução ficam no
contrato Messaging; [evidências de durabilidade e concorrência](docs/task07-outbox-report.md).

Abertura de wallet terá caso de uso e fronteira próprios, independentes de `ProcessWagerUseCase`; wallet, `OPENING` e crédito de abertura são atômicos quando há saldo inicial positivo (§9). `Wallet.open` preserva versão 1; a porta/adaptação de OPENING pertence a Financial e usa a tabela técnica compartilhada, sem importar Wagering. O fluxo é demonstrado pela integração, sem antecipar endpoint/caso de uso.

## Concorrência obrigatória e desenho planejado

§§5, 6.2 e 8 do [enunciado](docs/challenge.md): coordenação por `walletId`, sem lock global, saldo não negativo, nenhuma atualização perdida, wallets diferentes em paralelo e correção com pelo menos três instâncias. A integração escolhe `SELECT … FOR UPDATE` por registro, isolamento READ COMMITTED e atualização condicionada à versão lida sob lock como proteção adicional. O lock é mantido até commit/rollback. Wallets múltiplas devem ser adquiridas em ordem crescente dos UUIDs canônicos. Não há retries automáticos; falhas de lock/deadlock são propagadas e a política futura permanece pendente.

Duplicatas concorrentes e reversões exigem unicidade/integridade no PostgreSQL. Schema deve garantir unicidade, imutabilidade e não-negatividade exigidas, além da coordenação da aplicação; FIFO é otimização. Casos e resultado obrigatório estão no [plano de aceitação](docs/requirements.md), sem presumir que versionamento já escolheu optimistic locking.

### Task 06 — coordenação entregue

Ordem: reserva scope/key → advisory lock transacional de identidade externa → wallet FOR UPDATE → referência/histórico → Wagering → wallet/ledger → resultado idempotente → commit. Nenhuma referência exige adquirir outra wallet ou identidade externa; referência incompatível é rejeitada. Isso evita aquisição circular entre original/reversão e mantém wallets distintas paralelas. READ COMMITTED/refresh observa o estado confirmado após a espera. Falhas de lock/conexão/deadlock propagam e revertem; não viram FAILED automaticamente.

`INSERT ON CONFLICT DO NOTHING` reserva scope/key e espera o concorrente; leitura posterior sob lock compara hash e recupera snapshot. Uma reserva não confirmada desaparece no rollback/crash. Advisory usa hash PostgreSQL de tupla JSON com namespace, nunca lock global; colisão só aumenta contenção. UNIQUE(provider,external) reforça a identidade externa; outra key produz conflito de aplicação. [Migration202610280002](src/platform/persistence/migrations/Migration202610280002.ts) adiciona unicidade parcial de reversões PROCESSED por referência, sem impedir rejeições auditáveis. Dados cumulativos legados incompatíveis abortam a criação do índice; não são apagados.

Canonicalização, scope, zero, referências pendentes, failure codes e política conservadora de reversões são decisões locais aprovadas da Task 06, documentadas em [Wagering](docs/domain/wagering.md#task-06--políticas-e-contrato-aprovados). Resultado pendente confirmado também é COMPLETED na idempotência; replays não processam novamente. Futuro worker precisará atualizar somente resultado não terminal sob a mesma coordenação; PROCESSED mantém saldo histórico. Testes/evidências em [persistência](docs/persistence.md#task-06--processamento-atômico). Não se anuncia exactly-once delivery.

## Processos planejados

| Entrypoint em src  | Responsabilidade                                                      | Situação                      |
| ------------------ | --------------------------------------------------------------------- | ----------------------------- |
| `main.api.ts`      | HTTP e resposta síncrona do caso de uso, inclusive resultado pendente | Somente liveness implementada |
| `main.consumer.ts` | Receber SQS, Inbox, delegar processamento e ACK após commit           | Não implementado              |
| `main.worker.ts`   | Executar Outbox Publisher e Pending Reference Processor               | Não implementado              |

Outbox Publisher publica eventos; Pending Reference Processor reprocessa referências ausentes. São componentes distintos, mesmo no mesmo processo. HTTP e SQS chamam o mesmo `ProcessWagerUseCase` e compartilham a aplicação financeira, sem fluxo de saldo paralelo. Ciclo de vida deve permitir concluir mensagens ou devolver visibilidade no SIGTERM (§10). Não são necessários placeholders executáveis nesta etapa.

## Mensageria planejada

SQS FIFO de entrada, Inbox persistente e Outbox transacional são obrigatórios (§§6.5, 10–11). ACK somente depois do commit; publicação assíncrona por worker depois do commit. Entrega at-least-once permite republicação com identificador estável do evento; consumidores precisam tolerar duplicatas. Falha após commit não perde evento; outra instância recupera o trabalho. DLQ, backoff, tentativas limitadas e recuperação pertencem ao contrato de [Messaging](docs/domain/messaging.md).

Idempotência de negócio identifica operação e payload e preserva resultado original; deduplicação de mensagem usará `(consumerName, messageId)`. Uma não substitui a outra. A coordenação de negócio e inserção Outbox estão entregues; Inbox e protocolo de publicação permanecem pendentes.

## Requisitos obrigatórios e extensões opcionais

Stack de §4: PostgreSQL, AWS SQS via LocalStack ou MiniStack, Docker Compose e migrations versionadas/reversíveis. MikroORM foi escolhido conforme a decisão de persistência abaixo. Modelagem encapsulada/factories do domínio, eventos tipados e garantias no schema são obrigações, com detalhes em [requisitos](docs/requirements.md).

Autenticação (§2) é opcional, sem pontuação. Decisão de implementar ou omitir ainda pendente: se implementada, integrar IdP externo, sem usuários/senhas artesanais; se omitida, registrar desenho e ponto de extensão explícito em código. Não existe esse ponto no bootstrap atual. Health aberto e fila interna confiável não dispensam validação de provider no domínio.

Partidas dobradas, OpenTelemetry, dashboard e teste de carga são opcionais, não entregas aprovadas. Benefícios do monólito: uma transação SQL e contratos locais; custo: banco compartilhado, coordenação de hot wallets e disciplina de fronteiras. Processos separados não removem essas limitações. A aceitação distribuída só poderá ser demonstrada com infraestrutura/testes reais.

## Decisões pendentes e propostas

Nenhuma alternativa abaixo está aprovada. Registre decisão, justificativa, consequências e validação quando resolvida; divergências com o enunciado devem continuar visíveis.

| Tema                | Em aberto / restrição conhecida                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Locks               | Política futura de timeout/retries e tratamento dos conflitos/deadlocks propagados                                   |
| Unidade de trabalho | Ampliação futura para Inbox; inserção Outbox entregue na Task 07                                                     |
| OPENING             | Caso de uso e endpoint; infraestrutura e factory versão 1 já disponíveis                                             |
| Idempotência        | Atualização condicionada de resultado não terminal pelo futuro worker; hash/scope/replay já definidos na Task 06     |
| Inbox/Outbox        | Coordenação de claims, unicidade, publishers concorrentes e recuperação de publicação incerta                        |
| Retries/referências | Backoff exponencial obrigatório para referências; parâmetros/limites, aquisição concorrente e classificação de erros |
| TTL de referências  | Definir tentativas ou TTL e justificar; esgotamento rejeita e emite evento                                           |
| Filas de eventos    | Destinos, configuração FIFO/deduplicação, retenção e recuperação; entrada/DLQ já têm nomes no contrato               |
| Contratos externos  | Status HTTP e integração com transportes; failure codes de negócio definidos na Task 06                              |
| Falhas permanentes  | Classificação explícita para FAILED e coordenação com DLQ; falhas transitórias propagam rollback                     |
| Autenticação        | Implementar IdP ou omitir com desenho/ponto de extensão explícito                                                    |

Locks dos adapters e processamento financeiro completo são exercitados em três processos independentes na Task 06; aceitação de mensageria/publicação continua futura. Não há prazo ou limite comercial de dinheiro definido.

## Núcleo financeiro — decisão autorizada pela tarefa Financial Domain Core

Money usa `bigint` em unidades de 1/100: aritmética exata sem dependência externa e serialização decimal com duas casas. Criação aceita valores não negativos; reidratação também reconstrói resultados negativos internos. Moeda é validada por catálogo ISO local revisável, sem depender do locale/runtime. Contrato completo e fonte do catálogo estão em [Financial](docs/domain/financial.md).

Wallet protege saldo/versão/datas em campos privados; Money, ledger e movimentação são congelados em execução. Datas entram como cópias e saem como cópias. Factories validam estado estrutural; reidratação não aplica transições. IDs internos seguem UUID do schema, playerId permanece texto e versão respeita INTEGER SQL (máximo 2147483647), sem impor teto monetário.

`Wallet.create` permanece somente a zero; crédito/débito retornam a descrição imutável da mudança, ou `undefined` para zero sem efeitos. Ledger exige movimento positivo e valida a equação e moedas. ProcessWagerUseCase vincula transactionId e persiste tudo na mesma transação, com coordenação por wallet. A tarefa de integração acrescentou `Wallet.open`, com [proposta prévia](docs/financial-persistence-proposal.md), preservando as factories existentes e permitindo abertura positiva com versão 1 sem crédito comum.

## Integração financeira — decisão autorizada pela tarefa Financial Persistence Integration

Portas públicas pertencem a cada módulo. `FinancialTransactionContext` contém wallet, ledger e OPENING; `UnitOfWork<Context>` permite a extensão Wagering sem inversão de dependência. A genericidade limita-se ao contexto e resultado do callback; não há CRUD genérico. A inserção técnica de registros já processados permanece compatível; a Task 06 acrescenta portas completas de entidades e idempotência, sem mover regras para adapters.

Platform oferece `MikroOrmUnitOfWork` e a sessão técnica, sem importar módulos. [Bootstrap](src/bootstrap/persistence.ts) compõe os adapters em cada execução e registra `UNIT_OF_WORK` no Nest. Cada execução usa fork limpo e transação independente; colaboradores de uma mesma operação devem receber o contexto, nunca chamar `execute` novamente. O callback resolve somente depois do commit; erros não tratados provocam rollback e são propagados. Sessões encerradas rejeitam uso posterior dos repositórios.

Os adapters executam INSERT/UPDATE imediatamente na transação recebida, sem flush/commit próprio ou upsert. Inserção distingue-se da atualização; `save` exige a mesma instância obtida com `lockById` nessa execução, atualiza somente saldo/versão/data e não grava quando a versão não mudou. Mappers nos adapters fazem reconstrução explícita e exata, sem aplicar crédito/débito. Ordem das FKs: wallet → transação → ledger. O coordenador permanece responsável pela correspondência entre os três efeitos; UnitOfWork não contém regra de negócio. Contratos e testes em [persistência](docs/persistence.md#integração-financeira-e-unitofwork).

## Fundação de persistência — decisão aprovada nesta tarefa

**MikroORM com PostgreSQL é a implementação de persistência escolhida.** A tarefa Persistence Foundation autoriza esta escolha. Versões exatas ficam no package.json/lockfile. Integração oficial NestJS gerencia inicialização, contexto por requisição e fechamento; `EntityManager.transactional()` fornece commit/rollback explícitos; `LockMode.PESSIMISTIC_WRITE` permite locks por registro; Migrator fornece histórico e reversão versionada. O driver PostgreSQL usa `pg`, sem binding nativo obrigatório. Compatibilidade com Bun é verificada executando CLI, API compilada e testes reais, sem presumir equivalência de runtimes. Fontes: [NestJS](https://mikro-orm.io/docs/usage-with-nestjs), [transações](https://mikro-orm.io/docs/transactions), [migrations](https://mikro-orm.io/docs/migrations).

Modelos técnicos declarativos, sem regras de negócio, ficam em Platform Persistence e não importam módulos. A lista de entidades é explícita e não depende de decorators ou descoberta de arquivos. Mapeamentos de/para domínio e repositórios pertencem aos adapters de cada módulo; nenhum tipo ORM atravessa domain/application/public. Bootstrap compõe conexão, UnitOfWork e ciclo de vida. Não há sincronização automática, migration no startup ou alteração nas regras ESLint/Dependency Cruiser.

Decisões tomadas **antes da migration inicial**:

| Tema                   | Decisão e consequência                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro               | `NUMERIC` sem precisão máxima comercial, com CHECK de escala exatamente 2, finitude e não-negatividade. O banco rejeita casas excedentes em vez de arredondar. O ORM mantém strings e compara strings integralmente, inclusive mudanças de centavos acima da precisão de number. Entradas SQL também devem fornecer duas casas (`0.00`). O limite técnico é o do PostgreSQL; um limite de negócio continua pendente. [NUMERIC](https://www.postgresql.org/docs/current/datatype-numeric.html) sem typmod evita inventar um teto e a coerção de `NUMERIC(p,2)`. |
| Identidades            | UUID apenas para IDs internos; player/provider/round/game e IDs externos são text sem impor o formato dos exemplos. Moeda tem três letras maiúsculas, sem catálogo ISO no banco; validação ISO pertence ao domínio futuro. Wallet única por player/moeda.                                                                                                                                                                                                                                                                                                      |
| Referência pendente    | ID externo preservado junto ao provider; FK interna nullable, nunca inventada antes da resolução. Campos attempts, next_attempt_at, last_attempt_at, last_error e updated_at permitem retomar trabalho. Índice parcial de vencimento para PENDING_REFERENCE. Sem TTL/backoff, claims ou transições implementados.                                                                                                                                                                                                                                              |
| OPENING                | Registro físico em wager_transactions admite contexto externo nulo para OPENING. É uma estrutura compartilhada de armazenamento, não uma dependência Financial → Wagering. A integração financeira implementa a porta e o adapter Financial para gravá-lo na transação de abertura. Nenhum endpoint/caso de uso de abertura é entregue.                                                                                                                                                                                                                        |
| Unicidade de operações | `(provider_id, external_transaction_id)` único para identidade externa. Resultado/replay com outra key continua pendente. Reversões PROCESSED únicas por `(reference_transaction_id, kind)` para REFUND/ROLLBACK, preservando a restrição por tipo, sem impedir registrar tentativas rejeitadas.                                                                                                                                                                                                                                                               |
| Ledger                 | Único por `(transaction_id, wallet_id)`; FKs restritivas, aritmética DEBIT/CREDIT e saldos não negativos. FK composta garante que wallet/moeda do lançamento correspondam à transação e à wallet. Trigger bloqueia UPDATE/DELETE e TRUNCATE. Atomicidade saldo/ledger e ausência de lançamentos para LOSS/rejeições serão coordenadas pelo futuro caso de uso, não por regras em modelos ORM.                                                                                                                                                                  |
| Inbox                  | Estados técnicos RECEIVED/PROCESSED coerentes com processed_at; tentativas, last_error e updated_at rastreiam processamento. Não decide quando um resultado pendente pode receber ACK.                                                                                                                                                                                                                                                                                                                                                                         |
| Outbox                 | Estados técnicos PENDING/PUBLISHED coerentes com published_at, event_id único/estável, envelope JSONB integral, event_type/version, aggregate/correlation/causation, occurred_at, attempts e datas de recuperação. Índice parcial `(next_attempt_at, created_at, id)` para PENDING. Sem estado de claim/lease até definir aquisição e publicação incerta; falha tenta novamente como PENDING.                                                                                                                                                                  |
| Idempotência           | scope/key únicos; payload_hash opaco (algoritmo pendente); estados técnicos IN_PROGRESS/COMPLETED. JSONB original_result guarda a resposta original completa, inclusive saldo histórico e metadados de resposta quando definidos. COMPLETED exige resultado e transação; FK nullable permite reserva ainda sem transação. Não decide quando completar resultado pendente/rejeitado/falho e não implementa hash/replay.                                                                                                                                         |
| Reversão               | down remove estruturas em ordem inversa e recusa execução se o ledger contiver lançamentos; teste usa banco descartável sem ledger confirmado. Não é procedimento para apagar histórico em produção. Com dados financeiros, adotar migration corretiva forward e backup.                                                                                                                                                                                                                                                                                       |

O [schema físico e a matriz de integridade](docs/persistence.md) documentam colunas, índices e limites. A tabela acima registra o desenho da fundação original; as políticas entregues posteriormente estão na seção Task 06 e no contrato Wagering. Retries agendados, TTL e mensageria permanecem futuros.
