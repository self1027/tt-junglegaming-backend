# Arquitetura do Distributed Wagering Processor

## Status e autoridade

O [enunciado](docs/challenge.md) é a fonte imutável dos requisitos. O [índice de requisitos](docs/requirements.md) aponta seus contratos e critérios. Aqui ficam decisões estruturais; regras financeiras, operações e transporte ficam em [docs/domain](docs/domain/). **Aprovada** significa determinada pela tarefa de arquitetura/bootstrap; **obrigatória** vem do enunciado; **pendente/proposta** não autoriza implementação como contrato fechado.

Implementado: API NestJS em [src/main.api.ts](src/main.api.ts), composição em [src/bootstrap](src/bootstrap/), `GET /health/live`, fundação PostgreSQL/MikroORM e núcleo de domínio [Financial](docs/domain/financial.md) (Money, Wallet e WalletLedgerEntry, com testes em [test](test/)). Não há domínio de apostas, repositórios de aplicação, processamento Inbox/Outbox, SQS, consumer, worker, readiness ou reconciliação. Dockerfile preservado; [compose.yaml](compose.yaml) oferece PostgreSQL.

## Decisões aprovadas

- Monólito modular hexagonal, com processos escaláveis separadamente. NestJS, TypeScript strict, Bun 1.x, ESLint strict type-aware e Prettier com tabs/largura 4. Versões executáveis pertencem ao [package.json](package.json).
- Contexto segue a separação do material `../sam/`, capítulos 04–06: orientação como índice, contratos por domínio, procedimentos com entradas/etapas/evidências e validação proporcional. Exemplos didáticos daquele material não adicionam requisitos financeiros. As instruções operacionais são autossuficientes neste repositório.
- Graphify é o índice derivado de navegação do código, consultado antes de exploração ampla. Extração estrutural local (AST e títulos/links de documentos), sem LLM, e leitura dirigida das fontes preservam a autoridade do enunciado e dos contratos; o grafo não comprova invariantes. Setup, cobertura e atualização pertencem a [docs/tooling/graphify.md](docs/tooling/graphify.md).
- Distribuição de responsabilidades e dependências abaixo; fronteira transacional coordenada pela aplicação de Wagering. Contratos definitivos ainda serão desenhados.

| Escopo                              | Responsabilidade planejada                                     |
| ----------------------------------- | -------------------------------------------------------------- |
| [Financial](src/modules/financial/) | Money, wallet, movimentações, ledger, abertura e reconciliação |
| [Wagering](src/modules/wagering/)   | Operações, estados, referências, idempotência e orquestração   |
| [Platform](src/platform/)           | Mensageria, persistência e observabilidade técnicas            |
| [Bootstrap](src/bootstrap/)         | Composição concreta, inicialização e ciclo de vida             |

Cada módulo contém `domain`, `application`, `public` e `adapters`. `public` expõe contratos sem importar adapters. Domain não depende de frameworks; application depende de contratos, não implementações. Adapters implementam portas da aplicação. Financial não depende de Wagering; Wagering usa somente contratos públicos de Financial. Nenhum módulo acessa detalhes internos de outro. Platform não importa módulos; adapters dos módulos podem implementar suas portas usando recursos técnicos de Platform. Bootstrap compõe as implementações concretas; regras de negócio ficam fora dele e dos controllers.

As regras atuais em [.dependency-cruiser.cjs](.dependency-cruiser.cjs) e [eslint.config.mjs](eslint.config.mjs) reforçam essas fronteiras, inclusive imports de tipos e ciclos. As camadas internas atualmente também vedam imports de pacotes externos: isso precisa ser considerado ao propor uma biblioteca decimal, sem relaxar a regra silenciosamente. O grafo atual abre exceção apenas a `main.api.ts` para importar bootstrap; novos entrypoints precisarão de ajuste localizado e testes na futura implementação.

## Unidade transacional planejada

`ProcessWagerUseCase`, em application de Wagering, coordena o processamento completo por uma porta de unidade de trabalho. O contexto recebido oferece repositórios associados **à mesma transação**, sem tipos do ORM nos contratos internos.

Conforme aplicável à entrada/operação, a unidade atômica abrange validação e persistência de idempotência, WagerTransaction, alteração de saldo, ledger, Inbox SQS e eventos na Outbox. A implementação da unidade de trabalho faz commit/rollback; a aplicação financeira participa do contexto recebido e **não abre transação independente**. Trata-se do desenho aprovado para cumprir §§6.5 e 11 do [enunciado](docs/challenge.md), não de uma interface já implementada.

Abertura de wallet tem caso de uso e fronteira próprios, independentes de `ProcessWagerUseCase`; wallet, `OPENING` e crédito de abertura são atômicos quando há saldo inicial positivo (§9). A localização do registro interno `OPENING` deve respeitar a independência Financial → Wagering; seu mecanismo ainda está pendente.

## Concorrência obrigatória e desenho planejado

§§5, 6.2 e 8 do [enunciado](docs/challenge.md): coordenação por `walletId`, sem lock global, saldo não negativo, nenhuma atualização perdida, wallets diferentes em paralelo e correção com pelo menos três instâncias. Locks/controle de concorrência por wallet devem coordenar processos pelo banco, não somente memória. A estratégia exata de aquisição, isolamento e retries permanece pendente.

Duplicatas concorrentes e reversões exigem unicidade/integridade no PostgreSQL. Schema deve garantir unicidade, imutabilidade e não-negatividade exigidas, além da coordenação da aplicação; FIFO é otimização. Casos e resultado obrigatório estão no [plano de aceitação](docs/requirements.md), sem presumir que versionamento já escolheu optimistic locking.

## Processos planejados

| Entrypoint em src  | Responsabilidade                                                      | Situação                      |
| ------------------ | --------------------------------------------------------------------- | ----------------------------- |
| `main.api.ts`      | HTTP e resposta síncrona do caso de uso, inclusive resultado pendente | Somente liveness implementada |
| `main.consumer.ts` | Receber SQS, Inbox, delegar processamento e ACK após commit           | Não implementado              |
| `main.worker.ts`   | Executar Outbox Publisher e Pending Reference Processor               | Não implementado              |

Outbox Publisher publica eventos; Pending Reference Processor reprocessa referências ausentes. São componentes distintos, mesmo no mesmo processo. HTTP e SQS chamam o mesmo `ProcessWagerUseCase` e compartilham a aplicação financeira, sem fluxo de saldo paralelo. Ciclo de vida deve permitir concluir mensagens ou devolver visibilidade no SIGTERM (§10). Não são necessários placeholders executáveis nesta etapa.

## Mensageria planejada

SQS FIFO de entrada, Inbox persistente e Outbox transacional são obrigatórios (§§6.5, 10–11). ACK somente depois do commit; publicação assíncrona por worker depois do commit. Entrega at-least-once permite republicação com identificador estável do evento; consumidores precisam tolerar duplicatas. Falha após commit não perde evento; outra instância recupera o trabalho. DLQ, backoff, tentativas limitadas e recuperação pertencem ao contrato de [Messaging](docs/domain/messaging.md).

Idempotência de negócio identifica operação e payload e preserva resultado original; deduplicação de mensagem usa `(consumerName, messageId)`. Uma não substitui a outra. Coordenação exata entre claims, locks e registros Inbox/Outbox está pendente; não se promete exactly-once.

## Requisitos obrigatórios e extensões opcionais

Stack de §4: PostgreSQL, AWS SQS via LocalStack ou MiniStack, Docker Compose e migrations versionadas/reversíveis. MikroORM foi escolhido conforme a decisão de persistência abaixo. Modelagem encapsulada/factories do domínio, eventos tipados e garantias no schema são obrigações, com detalhes em [requisitos](docs/requirements.md).

Autenticação (§2) é opcional, sem pontuação. Decisão de implementar ou omitir ainda pendente: se implementada, integrar IdP externo, sem usuários/senhas artesanais; se omitida, registrar desenho e ponto de extensão explícito em código. Não existe esse ponto no bootstrap atual. Health aberto e fila interna confiável não dispensam validação de provider no domínio.

Partidas dobradas, OpenTelemetry, dashboard e teste de carga são opcionais, não entregas aprovadas. Benefícios do monólito: uma transação SQL e contratos locais; custo: banco compartilhado, coordenação de hot wallets e disciplina de fronteiras. Processos separados não removem essas limitações. A aceitação distribuída só poderá ser demonstrada com infraestrutura/testes reais.

## Decisões pendentes e propostas

Nenhuma alternativa abaixo está aprovada. Registre decisão, justificativa, consequências e validação quando resolvida; divergências com o enunciado devem continuar visíveis.

| Tema                 | Em aberto / restrição conhecida                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Locks                | Aquisição por wallet, isolamento, conflitos/deadlocks e retries; sem lock global                                     |
| Unidade de trabalho  | Interface definitiva, contexto de repositórios e adapters, sem tipos de ORM                                          |
| OPENING              | Registro interno na abertura sem dependência Financial → Wagering                                                    |
| Idempotência         | Algoritmo do hash canônico, campos de negócio, escopo de unicidade e armazenamento do resultado original             |
| Inbox/Outbox         | Coordenação de claims, unicidade, publishers concorrentes e recuperação de publicação incerta                        |
| Retries/referências  | Backoff exponencial obrigatório para referências; parâmetros/limites, aquisição concorrente e classificação de erros |
| TTL de referências   | Definir tentativas ou TTL e justificar; esgotamento rejeita e emite evento                                           |
| Filas de eventos     | Destinos, configuração FIFO/deduplicação, retenção e recuperação; entrada/DLQ já têm nomes no contrato               |
| Contratos externos   | Taxonomia de failureCode, status HTTP e validações não especificadas, sem inventar códigos                           |
| Estados/ambiguidades | Matriz definitiva de transições e pontos sem definição em [Wagering](docs/domain/wagering.md)                        |
| Autenticação         | Implementar IdP ou omitir com desenho/ponto de extensão explícito                                                    |

`SELECT … FOR UPDATE` é validado como capacidade técnica nesta etapa, sem fechar a estratégia dos casos de uso. Nenhum prazo, limite comercial de dinheiro ou política financeira adicional foi definido aqui.

## Núcleo financeiro — decisão autorizada pela tarefa Financial Domain Core

Money usa `bigint` em unidades de 1/100: aritmética exata sem dependência externa e serialização decimal com duas casas. Criação aceita valores não negativos; reidratação também reconstrói resultados negativos internos. Moeda é validada por catálogo ISO local revisável, sem depender do locale/runtime. Contrato completo e fonte do catálogo estão em [Financial](docs/domain/financial.md).

Wallet protege saldo/versão/datas em campos privados; Money, ledger e movimentação são congelados em execução. Datas entram como cópias e saem como cópias. Factories validam estado estrutural; reidratação não aplica transições. IDs internos seguem UUID do schema, playerId permanece texto e versão respeita INTEGER SQL (máximo 2147483647), sem impor teto monetário.

Criação da Wallet é somente a zero; crédito/débito retornam a descrição imutável da mudança, ou `undefined` para zero sem efeitos. Ledger exige movimento positivo e valida a equação e moedas. A futura aplicação vinculará transactionId e persistirá tudo na mesma transação, com coordenação por wallet. Nenhum evento, porta, mapper, adapter ou UnitOfWork é antecipado. Abertura positiva com OPENING e versão 1 permanece pendente e não pode usar o crédito comum (que incrementa versão).

## Fundação de persistência — decisão aprovada nesta tarefa

**MikroORM com PostgreSQL é a implementação de persistência escolhida.** A tarefa Persistence Foundation autoriza esta escolha. Versões exatas ficam no package.json/lockfile. Integração oficial NestJS gerencia inicialização, contexto por requisição e fechamento; `EntityManager.transactional()` fornece commit/rollback explícitos; `LockMode.PESSIMISTIC_WRITE` permite locks por registro; Migrator fornece histórico e reversão versionada. O driver PostgreSQL usa `pg`, sem binding nativo obrigatório. Compatibilidade com Bun é verificada executando CLI, API compilada e testes reais, sem presumir equivalência de runtimes. Fontes: [NestJS](https://mikro-orm.io/docs/usage-with-nestjs), [transações](https://mikro-orm.io/docs/transactions), [migrations](https://mikro-orm.io/docs/migrations).

Modelos técnicos declarativos, sem regras de negócio, ficam em Platform Persistence e não importam módulos. A lista de entidades é explícita e não depende de decorators ou descoberta de arquivos. Mapeamentos futuros de/para domínio e repositórios pertencem aos adapters de cada módulo; nenhum tipo ORM atravessa domain/application/public. Bootstrap compõe conexão e ciclo de vida. Não há sincronização automática, migration no startup, UnitOfWork de aplicação ou alteração nas regras ESLint/Dependency Cruiser.

Decisões tomadas **antes da migration inicial**:

| Tema                   | Decisão e consequência                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro               | `NUMERIC` sem precisão máxima comercial, com CHECK de escala exatamente 2, finitude e não-negatividade. O banco rejeita casas excedentes em vez de arredondar. O ORM mantém strings e compara strings integralmente, inclusive mudanças de centavos acima da precisão de number. Entradas SQL também devem fornecer duas casas (`0.00`). O limite técnico é o do PostgreSQL; um limite de negócio continua pendente. [NUMERIC](https://www.postgresql.org/docs/current/datatype-numeric.html) sem typmod evita inventar um teto e a coerção de `NUMERIC(p,2)`. |
| Identidades            | UUID apenas para IDs internos; player/provider/round/game e IDs externos são text sem impor o formato dos exemplos. Moeda tem três letras maiúsculas, sem catálogo ISO no banco; validação ISO pertence ao domínio futuro. Wallet única por player/moeda.                                                                                                                                                                                                                                                                                                      |
| Referência pendente    | ID externo preservado junto ao provider; FK interna nullable, nunca inventada antes da resolução. Campos attempts, next_attempt_at, last_attempt_at, last_error e updated_at permitem retomar trabalho. Índice parcial de vencimento para PENDING_REFERENCE. Sem TTL/backoff, claims ou transições implementados.                                                                                                                                                                                                                                              |
| OPENING                | Registro físico em wager_transactions admite contexto externo nulo para OPENING. É uma estrutura compartilhada de armazenamento, não uma dependência Financial → Wagering. Futuro adapter Financial poderá gravá-lo na transação de abertura; contrato/porta ainda pendentes. Nenhum endpoint/caso de uso de abertura é entregue.                                                                                                                                                                                                                              |
| Unicidade de operações | `(provider_id, external_transaction_id)` único para identidade externa. Resultado/replay com outra key continua pendente. Reversões PROCESSED únicas por `(reference_transaction_id, kind)` para REFUND/ROLLBACK, preservando a restrição por tipo, sem impedir registrar tentativas rejeitadas.                                                                                                                                                                                                                                                               |
| Ledger                 | Único por `(transaction_id, wallet_id)`; FKs restritivas, aritmética DEBIT/CREDIT e saldos não negativos. FK composta garante que wallet/moeda do lançamento correspondam à transação e à wallet. Trigger bloqueia UPDATE/DELETE e TRUNCATE. Atomicidade saldo/ledger e ausência de lançamentos para LOSS/rejeições serão coordenadas pelo futuro caso de uso, não por regras em modelos ORM.                                                                                                                                                                  |
| Inbox                  | Estados técnicos RECEIVED/PROCESSED coerentes com processed_at; tentativas, last_error e updated_at rastreiam processamento. Não decide quando um resultado pendente pode receber ACK.                                                                                                                                                                                                                                                                                                                                                                         |
| Outbox                 | Estados técnicos PENDING/PUBLISHED coerentes com published_at, event_id único/estável, envelope JSONB integral, event_type/version, aggregate/correlation/causation, occurred_at, attempts e datas de recuperação. Índice parcial `(next_attempt_at, created_at, id)` para PENDING. Sem estado de claim/lease até definir aquisição e publicação incerta; falha tenta novamente como PENDING.                                                                                                                                                                  |
| Idempotência           | scope/key únicos; payload_hash opaco (algoritmo pendente); estados técnicos IN_PROGRESS/COMPLETED. JSONB original_result guarda a resposta original completa, inclusive saldo histórico e metadados de resposta quando definidos. COMPLETED exige resultado e transação; FK nullable permite reserva ainda sem transação. Não decide quando completar resultado pendente/rejeitado/falho e não implementa hash/replay.                                                                                                                                         |
| Reversão               | down remove estruturas em ordem inversa e recusa execução se o ledger contiver lançamentos; teste usa banco descartável sem ledger confirmado. Não é procedimento para apagar histórico em produção. Com dados financeiros, adotar migration corretiva forward e backup.                                                                                                                                                                                                                                                                                       |

O [schema físico e a matriz de integridade](docs/persistence.md) documentam colunas, índices e limites. As políticas de zero, terminalidade, referências ainda não processadas, canonicalização/hash, replay e retries descritas nos contratos permanecem pendentes; a fundação não as resolve silenciosamente.
