# Task 07 — entrega e evidências

## Resultado

Eventos tipados/versionados são inseridos na Outbox existente na mesma transação
PostgreSQL que confirma Wagering, wallet, ledger e resultado idempotente. Nenhum
evento é publicado. O [protocolo, payloads e matriz completa](domain/messaging.md#task-07--protocolo-v1-implementado)
permanecem no contrato principal de Messaging; este relatório registra implementação
e evidências, sem substituir os contratos.

## Implementação e arquivos

| Criado                                                                                                        | Responsabilidade                                                                       |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [integration-event.ts](../src/modules/wagering/public/integration-event.ts)                                   | Base abstrata, metadados validados, data defensiva e envelope JSON                     |
| [events.ts](../src/modules/wagering/public/events.ts)                                                         | Quatro classes v1, payloads específicos, validação/imutabilidade, união e porta append |
| [wager-events.ts](../src/modules/wagering/application/wager-events.ts)                                        | Matriz de fatos confirmados, sem duplicar decisões financeiras                         |
| [mikro-orm-outbox.repository.ts](../src/modules/wagering/adapters/persistence/mikro-orm-outbox.repository.ts) | INSERT na sessão transacional existente, sem commit/retry próprios                     |
| [wager-events.test.ts](../test/wager-events.test.ts)                                                          | Contratos, precisão, causalidade, serialização e entradas inválidas                    |
| [plano de checkpoints](superpowers/plans/2026-10-28-transactional-outbox.md)                                  | Decisões anteriores aos adapters e etapas de execução                                  |
| Este relatório                                                                                                | Inventário, evidências e limites da Task 07                                            |

| Modificado                                                                                                               | Alteração da Task 07                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [ProcessWagerUseCase](../src/modules/wagering/application/process-wager.use-case.ts)                                     | Chama append após os efeitos e antes de idempotency.complete, no callback original            |
| [Contexto Wagering](../src/modules/wagering/public/persistence.ts)                                                       | Acrescenta OutboxRepository sem expor ORM                                                     |
| [Exports públicos](../src/modules/wagering/public/index.ts)                                                              | Expõe contratos/classes de eventos                                                            |
| [Bootstrap](../src/bootstrap/persistence.ts)                                                                             | Compõe Outbox com a mesma TransactionSession de todos os participantes                        |
| [Unitários do processador](../test/process-wager.test.ts)                                                                | Matriz, ausência de duplicatas no replay/conflitos e propagação de falhas                     |
| [Integração do processador](../test/process-wager-persistence.test.ts)                                                   | Confere eventos por operação/ledger, rollback, precisão, concorrência e crash                 |
| [Processo de teste](../test/support/wager-process.ts)                                                                    | Leitor iniciado após crash, replay e retorno de código SQL injetado; logs apenas de metadados |
| [Messaging](domain/messaging.md), [Wagering](domain/wagering.md), [Financial](domain/financial.md)                       | Contrato principal de eventos e referências ao comportamento entregue                         |
| [Persistência](persistence.md), [arquitetura](../ARCHITECTURE.md), [requisitos](requirements.md), [README](../README.md) | Estado implementado, rastreabilidade e comandos reproduzíveis                                 |

O checkout já continha alterações da Task 06; elas foram preservadas. O inventário
acima descreve somente a Task 07, não atribui a esta tarefa todo o diff contra HEAD.
Branch local: `task07-transactional-outbox`. Não foi feito merge/push ou commit
misturando o trabalho anterior.

## Contratos e garantias

Todos os eventos são v1 e subclasses concretas de IntegrationEvent:

| Evento                           | Fato                                                  |
| -------------------------------- | ----------------------------------------------------- |
| WagerTransactionProcessed        | Operação aplicada, inclusive LOSS                     |
| WagerTransactionRejected         | Rejeição persistida com failureCode de negócio        |
| WagerTransactionPendingReference | Referência inexistente, operação pendente             |
| WalletBalanceChanged             | Mudança efetiva de saldo, com direção e saldos exatos |

A porta oferece somente `append(readonly WagerIntegrationEvent[])`. O adapter
reutiliza OutboxMessageRow e TransactionSession, com defaults PENDING/attempts 0,
next_attempt_at inicialmente elegível e published_at nulo. A sessão é invalidada
ao sair do callback, tanto no sucesso quanto na falha. Nenhuma migration nova:
schema, índices, checks e trigger existentes bastam. Migrations históricas e
`docs/challenge.md` permanecem preservados.

Cada evento confirmado mantém seu eventId. Replay retorna antes de construir eventos;
outra key para a mesma identidade externa e payload conflitante também não criam fatos.
Saldo do replay permanece histórico mesmo após outras operações. LOSS não altera
saldo/versão nem cria ledger/WalletBalanceChanged. Referência encontrada ainda não
processada permanece PENDING sem evento incompatível. Erros técnicos propagam com
rollback e não viram FAILED terminal.

## Evidências executáveis

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.1 e PostgreSQL 18.3
real em containers Compose exclusivos, removidos pelo harness com seus volumes.
Sem mocks para as garantias SQL. Comandos usam somente scripts existentes.

- TDD: unitários do processador falharam pela ausência dos eventos (12 falhas);
  após integração, 52 testes de contratos/processador passaram. Integração BET
  falhou pela ausência da porta no contexto; passou após composição do adapter.
- Atomicidade: BET/WIN/LOSS, REFUND/ROLLBACK e rejeições/pendências conferem
  estado, resultado COMPLETED, contagem/tipo/agregado/envelope dos eventos e
  reconstrução do saldo pelo ledger. Dinheiro acima de 53 bits preserva centavos
  no JSONB e no NUMERIC, com walletVersion correto.
- Falhas SQL em wallet, Wagering, ledger e idempotência revertem todos os efeitos;
  trigger de idempotência exige observar os dois eventos ainda não confirmados
  antes de falhar. Isso demonstra rollback também depois do append.
- Falha no segundo evento exige observar o primeiro INSERT antes de retornar 23514. Exercitada também em outro processo Bun. Após falha: zero registros
  Outbox da operação, zero claim, nenhum débito/ledger/Wagering parcial e retry
  posterior aplica uma vez. A consulta pelo walletId no JSONB também detectaria
  evento órfão sem transação de negócio confirmada.
- eventId repetido provoca 23505 e reverte lote/eventos e processamento financeiro.
  Defaults e metadados são lidos diretamente do PostgreSQL, inclusive por conexão
  nova. Contextos encerrados recusam append, inclusive após rollback.
- Três processos independentes disputam mesma operação/key e identidade externa:
  uma aplicação financeira e um conjunto de dois eventos para BET; duplicados
  são replays ou conflitos conforme a key. São observadas esperas em
  pg_stat_activity antes de liberar a barreira, sem sleep como prova da corrida.
- 50 submissões paralelas em três pools independentes (17+17+16): um débito,
  um ledger, dois eventos e 49 replays. Eventos também são conferidos em
  reversões concorrentes, disputa 100/80/80 e referência fora de ordem.
- Wallets distintas confirmam enquanto uma terceira operação permanece parada
  antes do commit. A Outbox não introduz lock global.
- Crash antes do commit ocorre depois de preparar/inserir eventos: outra conexão
  observa ausência de todos os efeitos enquanto os concorrentes esperam em SQL;
  matar o produtor libera rollback, uma tentativa aplica e outra faz replay.
- Crash depois do commit ocorre antes da resposta: os dois eventos PENDING já
  são visíveis; o produtor é morto. Um leitor Bun iniciado depois do crash
  consulta os mesmos IDs/tipos/versões e executa replay; outros processos também
  fazem replay. Registros completos, IDs e timestamps permanecem iguais.

## Validação final

| Comando / check                    | Resultado observado                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                | Passou                                                                                                                                            |
| `bun run lint`                     | Passou; arquitetura sem violações, 49 módulos/150 dependências                                                                                    |
| `bun run test`                     | **272 passaram, 0 falharam, 2.588 asserções, 13 arquivos**, 43,72 s                                                                               |
| `bun run build`                    | Passou                                                                                                                                            |
| Migrations / arquitetura negativa  | Incluídas na suíte completa; PostgreSQL up/status/down/up, proteção do ledger e migration de reversões passaram; 21 testes arquiteturais passaram |
| `git diff --check`                 | Passou                                                                                                                                            |
| Preservação de fontes/configuração | Enunciado, migration inicial, package/lockfile e regras ESLint/Dependency Cruiser sem diff                                                        |
| Links relativos/âncoras            | 208 referências em 9 documentos resolvidas, nenhuma falha                                                                                         |
| Graphify                           | Atualização operacional: 746 nós, 1.711 relações; consulta final localizou WagerIntegrationEvent, MikroOrmOutboxRepository e wagerEvents          |

`bun run format:check` será registrado após a formatação final deste relatório.

PIDs e barreiras da execução completa, sem payload financeiro nos logs:

| Cenário                 | Processos / resultado                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Mesma key               | 19436 deteve commit; 22100/25660 esperaram em SQL e fizeram replay; somente dois eventos                         |
| 50 duplicatas           | 28876 aplicou 1/fez 16 replays; 29616 fez 17 replays; 27820 fez 16 replays; somente dois eventos                 |
| Crash antes de commit   | 23212 morto na barreira; 24160 aplicou; 10756 fez replay; sem efeitos parciais antes do retry                    |
| Crash depois de commit  | 18840 morto após commit; 23636 iniciado depois leu dois eventos PENDING e fez replay; 24216/25696 fizeram replay |
| Falha no segundo evento | 7408 recebeu SQL 23514; primeiro evento e efeitos financeiros revertidos; retry posterior válido                 |

No crash confirmado, eventIds `f512961b-8d87-4ec5-9745-822a1de04f14`
(WagerTransactionProcessed) e `84c23610-63c7-463c-b45a-94be5ab9f21b`
(WalletBalanceChanged) foram recuperados com versão 1/status PENDING pelo novo
processo. A comparação integral no PostgreSQL confirmou IDs/timestamps/payloads
inalterados após replays. Esses são identificadores de fixtures descartáveis.

Graphify foi consultado inicialmente com ProcessWagerUseCase/UnitOfWork/outbox_messages
e explain de ProcessWagerUseCase; foram conferidos caso de uso, contratos públicos,
bootstrap, sessão/UoW, modelos/migration e testes localizados. A atualização extraiu
os símbolos novos sem LLM/API. Limite estrutural reportado pelo CLI: quatro arquivos
sem símbolos individuais, incluindo os dois barrels públicos, configuração CLI e
fixture wallet-lock; imports/conteúdo pertinente foram conferidos diretamente.

## Revisão independente

Revisor separado examinou contratos, aplicação, adapter, composição e harness;
não encontrou defeitos executáveis bloqueantes. A revisão documental identificou
três referências desatualizadas a eventos futuros em Wagering e uma descrição
imprecisa de débito; esses textos foram corrigidos antes da entrega. Executou de forma
independente os unitários de contratos/processador: 52 passaram, 0 falharam,
159 asserções. As integrações e a documentação final são validadas pelo executor;
o revisor não alegou tê-las executado/revisado integralmente.

## Limites e próxima etapa

Nenhum publisher, polling, SQS/LocalStack, Inbox, ACK/DLQ, retry de publicação,
claim/lease, worker de referências, endpoint ou observabilidade nova foi criado.
A intenção de publicação é durável; não representa entrega confirmada nem
exactly-once delivery. O banco ainda é a fronteira de coordenação; testes cobrem
os cenários descritos, não todos os clientes SQL possíveis.

Próxima etapa: definir aquisição concorrente, recuperação de publicação incerta,
destinos e backoff do publisher, preservando eventId/envelope persistidos; então
implementar e testar publicação at-least-once com SQS real/LocalStack e consumidores
tolerantes a duplicatas. Reprocessamento de referências permanece componente distinto.
