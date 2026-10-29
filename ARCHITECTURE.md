# Arquitetura do Distributed Wagering Processor

## Status e autoridade

O [enunciado](docs/challenge.md) é a fonte imutável dos requisitos. O [índice de requisitos](docs/requirements.md) aponta seus contratos e critérios. Aqui ficam decisões estruturais; regras financeiras, operações e transporte ficam em [docs/domain](docs/domain/). **Aprovada** significa determinada pela tarefa de arquitetura/bootstrap; **obrigatória** vem do enunciado; **pendente/proposta** não autoriza implementação como contrato fechado.

Implementado: API NestJS em [src/main.api.ts](src/main.api.ts), composição em [src/bootstrap](src/bootstrap/), [contratos HTTP](docs/http-api.md), abertura atômica/consultas/reconciliação, fundação PostgreSQL/MikroORM, domínio [Financial](docs/domain/financial.md), domínio [Wagering](docs/domain/wagering.md) e ProcessWagerUseCase com idempotência persistente, processamento financeiro atômico e eventos tipados na Outbox. Liveness independe das dependências; readiness verifica PostgreSQL e SQS/FIFO/redrive/DLQ. A Task 09 implementa Inbox transacional e consumer independente em [main.consumer.ts](src/main.consumer.ts). A Task 10 implementa publisher independente em [main.publisher.ts](src/main.publisher.ts); worker de referências está entregue na [Task 11](docs/pending-reference-worker.md). [Compose](compose.yaml) oferece PostgreSQL e LocalStack com perfil sqs. [Operação](docs/sqs-consumer.md).

## Decisões aprovadas

- Monólito modular hexagonal, com processos escaláveis separadamente. NestJS, TypeScript strict, Bun 1.x, ESLint strict type-aware e Prettier com tabs/largura 4. Versões executáveis pertencem ao [package.json](package.json).
- Contexto segue a separação do material `../sam/`, capítulos 04–06: orientação como índice, contratos por domínio, procedimentos com entradas/etapas/evidências e validação proporcional. Exemplos didáticos daquele material não adicionam requisitos financeiros. As instruções operacionais são autossuficientes neste repositório.
- Graphify é o índice derivado de navegação do código, consultado antes de exploração ampla. Extração estrutural local (AST e títulos/links de documentos), sem LLM, e leitura dirigida das fontes preservam a autoridade do enunciado e dos contratos; o grafo não comprova invariantes. Setup, cobertura e atualização pertencem a [docs/tooling/graphify.md](docs/tooling/graphify.md).
- Distribuição de responsabilidades e dependências abaixo; fronteira transacional coordenada pela aplicação de Wagering. O contexto inclui os participantes entregues, inclusive Outbox desde a Task 07 e Inbox desde a Task 09.

| Escopo                              | Responsabilidade planejada                                     |
| ----------------------------------- | -------------------------------------------------------------- |
| [Financial](src/modules/financial/) | Money, wallet, movimentações, ledger, abertura e reconciliação |
| [Wagering](src/modules/wagering/)   | Operações, estados, referências, idempotência e orquestração   |
| [Platform](src/platform/)           | Mensageria, persistência e observabilidade técnicas            |
| [Bootstrap](src/bootstrap/)         | Composição concreta, inicialização e ciclo de vida             |

Cada módulo contém `domain`, `application`, `public` e `adapters`. `public` expõe contratos sem importar adapters. Domain não depende de frameworks; application depende de contratos, não implementações. Adapters implementam portas da aplicação. Financial não depende de Wagering; Wagering usa somente contratos públicos de Financial. Nenhum módulo acessa detalhes internos de outro. Platform não importa módulos; adapters dos módulos podem implementar suas portas usando recursos técnicos de Platform. Bootstrap compõe as implementações concretas; regras de negócio ficam fora dele e dos controllers.

As regras atuais em [.dependency-cruiser.cjs](.dependency-cruiser.cjs) e [eslint.config.mjs](eslint.config.mjs) reforçam essas fronteiras, inclusive imports de tipos e ciclos. As camadas internas atualmente também vedam imports de pacotes externos: isso precisa ser considerado ao propor uma biblioteca decimal, sem relaxar a regra silenciosamente. Somente `main.api.ts`, `main.consumer.ts`, `main.publisher.ts` e `main.pending-worker.ts` podem importar bootstrap como entrypoints; a exceção adicional é localizada e testada. AWS SDK permanece na infraestrutura, e guardas negativos impedem commit próprio de Inbox e débito/crédito no consumer.

## Unidade transacional

`ProcessWagerUseCase`, em application de Wagering, coordena o processamento pela porta `UnitOfWork`. O contexto oferece repositórios associados **à mesma transação**, sem tipos do ORM nos contratos internos. Wagering estende o contexto financeiro público com WagerTransactionRepository e IdempotencyRepository. Financial não conhece essa extensão. [bootstrap/wagering.ts](src/bootstrap/wagering.ts) e ApiModule compõem o caso de uso sem lógica financeira. Controllers HTTP o reutilizam, sem caminho alternativo de saldo.

Na Task 06, a unidade atômica passou a abranger reserva/conclusão idempotente, WagerTransaction, wallet e ledger quando há mudança. A Task 07 inclui Outbox antes da conclusão idempotente. Uma única chamada a execute, sem retry interno; resposta somente após commit. A aplicação financeira participa do contexto recebido e **não abre transação independente**. Desde a Task 09, Inbox opcional participa dessa mesma unidade antes do processamento e conclui após o resultado idempotente.

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

CreateWalletUseCase tem fronteira própria, independente de `ProcessWagerUseCase`; wallet, `OPENING` e crédito de abertura são atômicos quando há saldo inicial positivo (§9). `Wallet.open` preserva versão 1; a porta/adaptação de OPENING pertence a Financial e usa a tabela técnica compartilhada, sem importar Wagering. Zero não cria registro fictício nem evento Wagering.

### Task 08 — adapters HTTP e leitura consistente

DTOs são allowlists runtime; domínio/casos de uso não importam Nest ou ORM. Controllers só delegam; pipes validam estrutura, Unicode, Money e header, e helper serializa o status do resultado. Filtro central na composição traduz erros de aplicação e constraints específicas, sanitiza falhas técnicas e distingue 400/404/409/422/503/500. ProcessWagerUseCase valida walletId informado inclusive em replay, preservando hash histórico e resolução por player/moeda. Consultas retornam projeções explícitas, sem ORM/key/hash.

UnitOfWork.execute aceita `{ readOnly: true }` para consultas/reconciliação: REPEATABLE READ READ ONLY na mesma sessão. Saldo e ledger compartilham snapshot sem locks exclusivos; escrita normal mantém READ COMMITTED e a coordenação anterior. Diferença exata é armazenado menos reconstruído. Divergência não modifica registros; diagnóstico gera log seguro e contador local por instância, sem exporter/agregação de métricas. Histórico completo é lido em memória nesta etapa. Ledger usa paginação keyset SQL com âncora na linha imutável para preservar microssegundos. [Evidências](docs/task08-http-report.md).

## Concorrência obrigatória e desenho planejado

§§5, 6.2 e 8 do [enunciado](docs/challenge.md): coordenação por `walletId`, sem lock global, saldo não negativo, nenhuma atualização perdida, wallets diferentes em paralelo e correção com pelo menos três instâncias. A integração escolhe `SELECT … FOR UPDATE` por registro, isolamento READ COMMITTED e atualização condicionada à versão lida sob lock como proteção adicional. O lock é mantido até commit/rollback. Wallets múltiplas devem ser adquiridas em ordem crescente dos UUIDs canônicos. HTTP/SQS propagam falhas de lock/deadlock sem retry interno. O worker agenda nova tentativa após rollback conforme a Task 11, sem mudar rejeições financeiras.

Duplicatas concorrentes e reversões exigem unicidade/integridade no PostgreSQL. Schema deve garantir unicidade, imutabilidade e não-negatividade exigidas, além da coordenação da aplicação; FIFO é otimização. Casos e resultado obrigatório estão no [plano de aceitação](docs/requirements.md), sem presumir que versionamento já escolheu optimistic locking.

### Task 06 — coordenação entregue

Ordem: reserva scope/key → advisory lock transacional de identidade externa → wallet FOR UPDATE → referência/histórico → Wagering → wallet/ledger → resultado idempotente → commit. Nenhuma referência exige adquirir outra wallet ou identidade externa; referência incompatível é rejeitada. Isso evita aquisição circular entre original/reversão e mantém wallets distintas paralelas. READ COMMITTED/refresh observa o estado confirmado após a espera. Falhas de lock/conexão/deadlock propagam e revertem; não viram FAILED automaticamente.

`INSERT ON CONFLICT DO NOTHING` reserva scope/key e espera o concorrente; leitura posterior sob lock compara hash e recupera snapshot. Uma reserva não confirmada desaparece no rollback/crash. Advisory usa hash PostgreSQL de tupla JSON com namespace, nunca lock global; colisão só aumenta contenção. UNIQUE(provider,external) reforça a identidade externa; outra key produz conflito de aplicação. [Migration202610280002](src/platform/persistence/migrations/Migration202610280002.ts) adiciona unicidade parcial de reversões PROCESSED por referência, sem impedir rejeições auditáveis. Dados cumulativos legados incompatíveis abortam a criação do índice; não são apagados.

Canonicalização, scope, zero, referências pendentes, failure codes e política conservadora de reversões são decisões locais aprovadas da Task 06, documentadas em [Wagering](docs/domain/wagering.md#task-06--políticas-e-contrato-aprovados). Resultado pendente confirmado também é COMPLETED na idempotência; replays não processam novamente. A Task 11 atualiza somente resultado não terminal sob a mesma coordenação; PROCESSED mantém saldo histórico. Testes/evidências em [persistência](docs/persistence.md#task-06--processamento-atômico). Não se anuncia exactly-once delivery.

## Processos e composição

| Entrypoint em src        | Responsabilidade                                                      | Situação                                    |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------- |
| `main.api.ts`            | HTTP e resposta síncrona do caso de uso, inclusive resultado pendente | Implementado; readiness real PostgreSQL/SQS |
| `main.consumer.ts`       | Receber SQS, Inbox, delegar processamento e ACK após commit           | Implementado                                |
| `main.publisher.ts`      | Publicar Outbox confirmada com claims/lease/fencing                   | Implementado na Task 10                     |
| `main.pending-worker.ts` | Resolver referências pendentes pelo motor compartilhado               | Implementado na Task 11                     |

Outbox Publisher publica eventos; Pending Reference Processor reprocessa referências ausentes. São componentes distintos, mesmo no mesmo processo. HTTP e SQS chamam o mesmo `ProcessWagerUseCase` e compartilham a aplicação financeira, sem fluxo de saldo paralelo. Ciclo de vida deve permitir concluir mensagens ou devolver visibilidade no SIGTERM (§10). Não são necessários placeholders executáveis nesta etapa.

## Mensageria

SQS FIFO de entrada, Inbox persistente e Outbox transacional são obrigatórios (§§6.5, 10–11). ACK somente depois do commit; publicação assíncrona por worker depois do commit. Entrega at-least-once permite republicação com identificador estável do evento; consumidores precisam tolerar duplicatas. Falha após commit não perde evento; outra instância recupera o trabalho. DLQ, backoff, tentativas limitadas e recuperação pertencem ao contrato de [Messaging](docs/domain/messaging.md).

Idempotência de negócio identifica operação e payload e preserva resultado original; deduplicação de mensagem usa `(consumerName, messageId)` do envelope. Uma não substitui a outra. A coordenação de negócio, Inbox e inserção Outbox estão entregues; protocolo de publicação está implementado na Task 10. ConsumerModule cria application context Nest sem listener HTTP, com UnitOfWork e caso de uso compartilhados; Platform não importa Wagering. Uma mensagem por ReceiveMessage, com pollers concorrentes, protege sucessoras de uma mensagem inválida contra gasto de tentativas sem processamento.

## Task 10 — publisher independente

[PublisherModule](src/bootstrap/publisher.module.ts) cria contexto Nest sem HTTP,
com pool PostgreSQL e cliente SDK próprios. Reutiliza configuração de persistência
e fábrica de cliente SQS. [OutboxPublisher](src/platform/messaging/outbox-publisher.ts)
depende somente de portas técnicas EventPublisher/OutboxStore, sem importar
módulos. O adapter SQS de Wagering conhece os contratos públicos dos quatro eventos;
Platform não importa negócios. Financial e ProcessWagerUseCase não mudam.

[Migration202610290001](src/platform/persistence/migrations/Migration202610290001.ts)
acrescenta token/owner/lease com CHECK coerente e proteção dos fatos históricos.
A aquisição SQL é uma unidade técnica própria e curta, distinta da UnitOfWork
financeira: SELECT FOR UPDATE SKIP LOCKED + UPDATE de claims + commit. Rede SQS
ocorre após liberar transação/locks. Finalização/retry são UPDATEs atômicos com
fencing por token e validade do lease; o próprio PostgreSQL é o relógio de autoridade.
Índice parcial existente limita seleção aos eventos vencidos, usando predicado
indexável por statement_timestamp. Lease não é renovado; orçamento de envio/SQL
é limitado e validado. Batch <= concorrência evita claims parados em fila local.

Fila wager-events.fifo separa saída de comandos. Envelope completo histórico com
version/data é validado e serializado deterministicamente; dedup ID = eventId,
grupo = data.walletId. Nenhuma ordem de commit na saída é prometida: FIFO ordena
chegadas ao grupo e as invariantes financeiras continuam protegidas no banco.
Sem transação distribuída, exactly-once ou sequência global. Aceite SQS pode ser
repetido após crash antes da marcação SQL, preservando o mesmo fato.

Retry ilimitado e backoff limitado preservam durabilidade e recuperabilidade,
inclusive para erros permanentes observáveis. Claims confirmados contam attempts.
Shutdown impede novos envios após parada da aquisição e drena os já iniciados;
prazo excedido permite recuperação por lease. Diagnósticos SQL/SQS/loop e contadores
locais não alteram health da API. O Compose continua fornecendo infraestrutura;
processos de aplicação seguem o padrão de execução separado já usado pelo consumer.
[Operação e testes](docs/outbox-publisher.md). Pending Reference Worker está implementado separadamente na Task 11 abaixo.

## Task 11 — worker de referências

[PendingWorkerModule](src/bootstrap/pending-worker.module.ts) compõe contexto Nest
SQL independente, sem HTTP/SQS. O entrypoint é main.pending-worker.ts. A tarefa
autoriza o worker, e o usuário aprovou TTL configurável de 24h desde criação,
backoff 1s–5min e revalidação antes de rejeitar. A [matriz de negócio](docs/domain/wagering.md#task-11--resolução-de-referências)
é a fonte principal; [operação](docs/pending-reference-worker.md) descreve os parâmetros.

ProcessWagerUseCase mantém entrada nova/Inbox; ResolvePendingWagerUseCase resolve
a entidade persistida. Ambos usam processWager e saveWagerBalanceChange; não há
outro motor, Money, ledger ou regra de reversão. O resolver nunca cria identidade,
key ou WagerTransaction nova. O contexto financeiro continua o mesmo.

Ordem global: SQS adquire Inbox; HTTP não. Ambos seguem idempotência → identidade
externa → wallet → referência/histórico. O worker confirma claim numa transação
curta sem manter locks e depois adquire idempotência existente → identidade externa
→ wallet → linha pendente/claim → referência/histórico. Não adquire locks de outra
wallet/referência externa. Publisher não participa desses locks; somente Outbox.
Adquirir claim com SKIP LOCKED não espera os recursos da transação financeira.

Wallet/ledger aplicáveis, atualização idempotente terminal, novos fatos Outbox e
UPDATE final de WagerTransaction/limpeza do claim confirmam numa única UnitOfWork.
O UPDATE final verifica token/estado esperado/lease válido e aborta tudo ao falhar.
Ledger aponta à operação já existente; nenhuma FK exige inserir uma nova identidade.
Erro técnico agenda retry somente após retorno da UnitOfWork, com fencing próprio;
commit incerto seguido de retry não modifica terminais. Nenhuma falha transitória
vira REJECTED/FAILED. Evento histórico de pendência permanece imutável.

Migration202610290002 acrescenta trio de claim e índice parcial para ambos os
estados, preservando NULL de scheduling legado via COALESCE. Down remove apenas
as estruturas novas, preservando histórico; parar workers antes de reverter.
Não foram alteradas migrations históricas ou dependências.

SQL usa statement_timeout = SQL, transaction_timeout = SQL + 1000ms e pool
acquireTimeout = SQL. A margem permite rollback após cancelamento de statement;
o limite total ainda pode encerrar conexão. Lease/shutdown >= 2 × SQL + 2000ms.
SIGTERM drena ou sai 1 ao prazo, mantendo recuperação por lease. [Relatório e
testes reais](docs/task11-pending-report.md), sem promessa de exactly-once.

## Requisitos obrigatórios e extensões opcionais

Stack de §4: PostgreSQL, AWS SQS via LocalStack ou MiniStack, Docker Compose e migrations versionadas/reversíveis. MikroORM foi escolhido conforme a decisão de persistência abaixo. Modelagem encapsulada/factories do domínio, eventos tipados e garantias no schema são obrigações, com detalhes em [requisitos](docs/requirements.md).

Autenticação (§2) foi omitida no escopo da Task 08, que exclui autenticação customizada. [NoAuthGuard](src/bootstrap/no-auth.guard.ts), registrado como APP_GUARD, é o ponto explícito no-op para futura integração OIDC com IdP externo (por exemplo Keycloak), validação de token/issuer/audience e vínculo de identidade ao provider. Essa futura integração deverá deixar health aberto; não há usuários/senhas artesanais nem autenticação efetiva agora. Health aberto e fila interna confiável não dispensam validação de provider no domínio.

Partidas dobradas, OpenTelemetry, dashboard e teste de carga são opcionais, não entregas aprovadas. Benefícios do monólito: uma transação SQL e contratos locais; custo: banco compartilhado, coordenação de hot wallets e disciplina de fronteiras. Processos separados não removem essas limitações. A aceitação distribuída só poderá ser demonstrada com infraestrutura/testes reais.

## Decisões pendentes e propostas

Nenhuma alternativa abaixo está aprovada. Registre decisão, justificativa, consequências e validação quando resolvida; divergências com o enunciado devem continuar visíveis.

| Tema                | Em aberto / restrição conhecida                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| Locks               | Política futura de timeout/retries e tratamento dos conflitos/deadlocks propagados                  |
| Unidade de trabalho | Inbox entregue na Task 09; inserção Outbox entregue na Task 07                                      |
| Idempotência        | Atualização condicionada não terminal → terminal entregue na Task 11; histórico terminal preservado |
| Inbox/Outbox        | Claims/lease/fencing e publicação incerta entregues na Task 10; referências entregues na Task 11    |
| Retries/referências | Backoff, aquisição e TTL entregues na Task 11; classificação técnica permanente continua pendente   |
| TTL de referências  | TTL configurável de 24h aprovado e implementado na Task 11, com revalidação antes de rejeitar       |
| Filas de eventos    | Saída wager-events.fifo e protocolo entregues na Task 10; consumidor downstream futuro              |
| Contratos externos  | Contratos v1/saída entregues; evolução e consumidores downstream futuros                            |
| Falhas permanentes  | Classificação explícita para FAILED e coordenação com DLQ; falhas transitórias propagam rollback    |
| Autenticação        | Integração futura com IdP; omissão e ponto de extensão registrados na Task 08                       |

Locks dos adapters e processamento financeiro completo são exercitados em três processos independentes na Task 06; entrada SQS/ACK/DLQ é exercitada na Task 09; publicação e recuperação entregues na Task 10. Não há prazo ou limite comercial de dinheiro definido.

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

O [schema físico e a matriz de integridade](docs/persistence.md) documentam colunas, índices e limites. A tabela acima registra o desenho da fundação original; as políticas entregues posteriormente estão na seção Task 06 e no contrato Wagering. Retries/TTL de referências entregues na Task 11; publicação entregue na Task 10; entrada SQS/Inbox está entregue na Task 09.
