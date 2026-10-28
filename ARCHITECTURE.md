# Arquitetura do Distributed Wagering Processor

## Status e autoridade

O [enunciado](docs/challenge.md) é a fonte imutável dos requisitos. O [índice de requisitos](docs/requirements.md) aponta seus contratos e critérios. Aqui ficam decisões estruturais; regras financeiras, operações e transporte ficam em [docs/domain](docs/domain/). **Aprovada** significa determinada pela tarefa de arquitetura/bootstrap; **obrigatória** vem do enunciado; **pendente/proposta** não autoriza implementação como contrato fechado.

Implementado: API NestJS em [src/main.api.ts](src/main.api.ts), composição em [src/bootstrap](src/bootstrap/), `GET /health/live` e testes em [test](test/). Não há Money, wallet, apostas, ORM, PostgreSQL, SQS, Inbox, Outbox, consumer, worker, readiness ou reconciliação. Dockerfile existe; Compose e serviços externos ainda estão planejados.

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

Stack de §4: PostgreSQL, AWS SQS via LocalStack ou MiniStack, Docker Compose e migrations versionadas/reversíveis. ORM deve ser **MikroORM (preferencial) ou TypeORM**; Prisma e outros estão fora do escopo. Escolha e mapeamento monetário exato precisam de justificativa futura. Modelagem encapsulada/factories, eventos tipados e garantias no schema são obrigações, com detalhes em [requisitos](docs/requirements.md).

Autenticação (§2) é opcional, sem pontuação. Decisão de implementar ou omitir ainda pendente: se implementada, integrar IdP externo, sem usuários/senhas artesanais; se omitida, registrar desenho e ponto de extensão explícito em código. Não existe esse ponto no bootstrap atual. Health aberto e fila interna confiável não dispensam validação de provider no domínio.

Partidas dobradas, OpenTelemetry, dashboard e teste de carga são opcionais, não entregas aprovadas. Benefícios do monólito: uma transação SQL e contratos locais; custo: banco compartilhado, coordenação de hot wallets e disciplina de fronteiras. Processos separados não removem essas limitações. A aceitação distribuída só poderá ser demonstrada com infraestrutura/testes reais.

## Decisões pendentes e propostas

Nenhuma alternativa abaixo está aprovada. Registre decisão, justificativa, consequências e validação quando resolvida; divergências com o enunciado devem continuar visíveis.

| Tema                     | Em aberto / restrição conhecida                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| ORM                      | MikroORM preferencial ou TypeORM aceito; sem escolha feita                                                           |
| Money interno/persistido | Representação exata, sem number/float/double; mapear/reidratar Money; compatibilizar dependências internas atuais    |
| Locks                    | Aquisição por wallet, isolamento, conflitos/deadlocks e retries; sem lock global                                     |
| Unidade de trabalho      | Interface definitiva, contexto de repositórios e adapters, sem tipos de ORM                                          |
| OPENING                  | Registro interno na abertura sem dependência Financial → Wagering                                                    |
| Idempotência             | Algoritmo do hash canônico, campos de negócio, escopo de unicidade e armazenamento do resultado original             |
| Inbox/Outbox             | Coordenação de claims, unicidade, publishers concorrentes e recuperação de publicação incerta                        |
| Retries/referências      | Backoff exponencial obrigatório para referências; parâmetros/limites, aquisição concorrente e classificação de erros |
| TTL de referências       | Definir tentativas ou TTL e justificar; esgotamento rejeita e emite evento                                           |
| Filas de eventos         | Destinos, configuração FIFO/deduplicação, retenção e recuperação; entrada/DLQ já têm nomes no contrato               |
| Contratos externos       | Taxonomia de failureCode, status HTTP e validações não especificadas, sem inventar códigos                           |
| Estados/ambiguidades     | Matriz definitiva de transições e pontos sem definição em [Wagering](docs/domain/wagering.md)                        |
| Autenticação             | Implementar IdP ou omitir com desenho/ponto de extensão explícito                                                    |

`SELECT … FOR UPDATE`, optimistic locking com retry e update condicionado são alternativas admitidas pelo §8, não decisões. Nenhum prazo, limite de dinheiro ou política financeira adicional foi definido aqui.
