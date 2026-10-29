# Messaging: entrada, eventos e recuperação

Requisitos **explícitos** dos §§3, 5, 6.0, 6.5, 7.1 e 9–13 de [challenge.md](../challenge.md), fonte primária imutável. Fronteiras/processos são decisões de [ARCHITECTURE.md](../../ARCHITECTURE.md). A Task 07 implementa eventos tipados e inserção transacional na Outbox pelo ProcessWagerUseCase. A Task 08 expõe esse mesmo fluxo por [HTTP](../http-api.md). A Task 09 acrescenta SQS FIFO, Inbox e consumer independente. A Task 10 implementa publicação recuperável por processo independente; referências são resolvidas pelo worker independente da Task 11.

## Entradas HTTP e SQS (§§9–10)

HTTP valida/adapta a entrada e chama ProcessWagerUseCase, retornando resultado síncrono do caso de uso, inclusive status pendente quando aplicável. Endpoints, header e categorias HTTP ficam em [requirements.md](../requirements.md); hash/replay em [Wagering](wagering.md). HTTP também registra Outbox atomicamente, sem publicar antes de commit.

Entrada SQS FIFO: `wager-transactions.fifo`, com `wager-transactions-dlq.fifo`. O envelope de entrada é `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`; data contém providerId, externalTransactionId, idempotencyKey, playerId, walletId, roundId, gameId, kind, money e referência quando exigida. occurredAt é timestamp ISO-8601 com data/hora e fuso explícito (Z ou offset); datas impossíveis são recusadas. A identidade da Inbox é messageId do envelope; o identificador nativo do broker é metadado de diagnóstico, nunca idempotencyKey.

Consumer separa recebimento de processamento: adapta mensagem, deduplica Inbox, chama **o mesmo use case HTTP**, confirma transação e só então ACK (remoção da mensagem). Fila é canal interno confiável para autenticação, mas provider continua validado pelo domínio (§2). OPENING externo é proibido (§6.3).

## Inbox e atomicidade (§§6.5, 10–11)

Deduplicação persistente por `(consumerName, messageId)`, sem depender somente do FIFO ou memória. Modelo de referência registra payloadHash, receivedAt, processedAt e transição markProcessed; usar factories/rehydrate conforme §6.0.

Inbox, idempotência/transação, saldo, ledger e Outbox aplicáveis participam da **mesma transação SQL**. PROCESSED na Inbox significa entrada tratada e duravelmente aceita, inclusive REJECTED, PENDING_REFERENCE e PENDING em Wagering. Pendências permanecem recuperáveis no PostgreSQL para o futuro worker; redelivery não as reprocessa. Mesmo messageId com hash divergente é conflito permanente, sem ACK, destinado à redrive nativa.

Inbox deduplica entrega do transporte. Idempotência de negócio identifica operação/payload e recupera resultado original; mensagens distintas podem representar a mesma operação. Ambas devem funcionar sob concorrência e reinicialização.

### Task 09 — protocolo de recepção implementado

`consumerName = wagering-v1`; produtores devem garantir messageId globalmente
único e estável por envelope (UUID ou identidade com namespace do produtor).
MessageGroupId recomendado é walletId canônico; agrupamento incorreto não remove
locks SQL. MessageDeduplicationId deve ser estável no retry de envio do mesmo
envelope. Não há ordem global entre grupos nem garantia baseada nos cinco minutos
de deduplicação FIFO. MessageId nativo, ReceiptHandle atual, grupo, dedup ID e
ApproximateReceiveCount ficam fora dos contratos financeiros.

[Parser](../../src/modules/wagering/adapters/sqs/wager-message.ts) usa allowlists
runtime, Money e validação Wagering existentes; exige walletId, recusa campos
desconhecidos, números monetários, Unicode malformado, JSON/envelope inválido e
OPENING. data.money vira command.amount; data.idempotencyKey é preservada.
Hash Inbox é SHA-256 UTF-8 de JSON explícito em ordem lexicográfica:
`data, messageId, occurredAt, type`; data contém
`externalTransactionId, gameId, idempotencyKey, kind, money, playerId, providerId,
referenceExternalTransactionId, roundId, walletId`. Money usa amount/currency
canônicos, walletId minúsculo, referência null/ausente vira null. Texto e
occurredAt preservam representação; alterar timestamp de envelope já identificado
gera conflito, mesmo se representar o mesmo instante. Não aceitar hash externo.
Esse hash difere intencionalmente do hash de negócio em [Wagering](wagering.md).

[Porta](../../src/modules/wagering/public/inbox.ts) oferece claim/complete, sem
CRUD/ORM/SQS. [Adapter](../../src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts)
usa a mesma TransactionSession e tabela existente. INSERT ON CONFLICT espera o
concorrente; FOR UPDATE confere hash/estado. Ordem global: **Inbox → idempotência
→ identidade externa → wallet → referências/histórico**. Nenhum participante
adquire outra Inbox nem confirma transação própria. Não há lease persistente.

RECEIVED novo só existe na transação em andamento; rollback/crash elimina claim,
efeitos e conclusão juntos. Um RECEIVED legado confirmado pode ser retomado sob
lock, sem ser tratado como sucesso. PROCESSED/hash igual retorna duplicata antes
do motor financeiro. attempts conta participações confirmadas (inclui duplicatas),
não entregas/rollbacks; last_error não recebe commit técnico separado. Erros de
tentativas revertidas ficam em logs seguros e no receive count/DLQ do broker.

`ProcessWagerUseCase.execute(command, delivery)` participa opcionalmente da Inbox;
HTTP mantém execute(command) e resultado histórico. Duplicata Inbox retorna
undefined internamente, traduzido para diagnóstico DUPLICATE. A Promise só resolve
após commit; somente então DeleteMessage pode ocorrer. Falha no ACK é registrada
separadamente de falha de processamento; redelivery usa o ReceiptHandle atual.

| Entrada/resultado                                                     | Tratamento                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| PROCESSED, REJECTED, PENDING_REFERENCE, PENDING persistidos           | Inbox PROCESSED no mesmo commit, depois ACK                    |
| Duplicata Inbox com hash igual                                        | Commit da tentativa, depois ACK; nenhum efeito novo            |
| JSON/envelope/Money/identidade inválidos                              | Sem processamento/ACK; redrive nativa                          |
| Conflito Inbox, idempotente, identidade externa ou wallet inexistente | Erro permanente, rollback e sem ACK; redrive nativa            |
| SQL/conexão/deadlock/erro inesperado ou IDEMPOTENCY_IN_PROGRESS       | Falha técnica, rollback e sem ACK; retry limitado pela redrive |
| DeleteMessage incerto/falho                                           | Commit preservado; redelivery reconhece Inbox                  |

Configuração operacional e comandos pertencem a [sqs-consumer.md](../sqs-consumer.md).
Default: redrive após 5 recebimentos, FIFO/DLQ/ARN/RedriveAllowPolicy verificados
sem consumir; retry de falha usa min(visibility, 2^receiveCount), limitado a 256s.
Receber **uma mensagem por chamada** evita gastar tentativas das sucessoras de
uma mensagem inválida. Concorrência vem de pollers independentes (default 4)
e processos distintos. ApproximateReceiveCount conta recebimentos aproximados,
inclusive entregas que não chegaram à aplicação, e não equivale a attempts SQL.

Visibilidade default 60s, extensões a cada 1/3 do prazo, limitadas por duração de
processamento (120s). Limite cobre também a decisão de ACK; falha na extensão
impede novas mensagens daquele recebimento e adia ACK, mesmo se houver commit.
PostgreSQL do consumer recebe statement_timeout e transaction_timeout iguais ao
limite via conexão. SIGTERM/SIGINT abortam polling e impedem novo trabalho;
operações em andamento drenam por até 30s. Prazo esgotado termina com código 1,
sem ACK de operação incompleta; desconexão libera locks e permite redelivery.
Não há promessa de conclusão após SIGKILL. SDK/pool fecham no caminho normal.

## Outbox e publicação (§§6.5, 11)

Evento confirmado é persistido com efeitos financeiros no commit. Worker publica depois, com múltiplos publishers concorrentes, sem perder eventos nem duplicá-los indefinidamente. Modelo de referência inclui id, aggregateId, eventType, payload readonly, occurredAt, attempts, nextAttemptAt e publishedAt; consultas pending/due e transições de publicação/retry com backoff.

Falha entre publicação e marcação pode causar republicação: preservar eventId estável e envelope persistido; consumidor tolera duplicatas. A entrega é **at-least-once**, não exactly-once. Claims persistentes com lease/fencing e backoff estão implementados na Task 10 abaixo. Outbox Publisher e Pending Reference Processor são componentes distintos; o segundo resolve referências com política descrita em [Wagering](wagering.md).

## Task 10 — publicação recuperável

Outbox Publisher é infraestrutura de integração independente de HTTP/consumer e
não executa regras financeiras. [Operação/configuração](../outbox-publisher.md),
[porta técnica](../../src/platform/messaging/outbox.ts),
[adapter SQL](../../src/platform/persistence/mikro-orm-outbox-store.ts) e
[adapter SQS](../../src/modules/wagering/adapters/sqs/sqs-event-publisher.ts).

Fila de saída `wager-events.fifo`, distinta de comandos/DLQ, com retenção de
14 dias no provisionamento local. MessageDeduplicationId = eventId persistido;
MessageGroupId = data.walletId nos quatro eventos v1. O JSON público preserva
version/data e todos os valores históricos, com ordenação recursiva das chaves.
Validação reutiliza os contratos existentes e confere igualdade integral, sem
normalização silenciosa ou reconstrução a partir do estado atual.

Ordem exigida pelo desafio: correção financeira por wallet no banco. A saída
oferece somente FIFO por ordem de chegada no grupo, sem ordem de commit, ordem
global ou ordem fixa entre eventos irmãos sob publishers concorrentes. Não se
adiciona sequência global. Deduplicação SQS dura cinco minutos; consumidor
posterior precisa tolerar duplicatas por eventId além dessa janela.

Aquisição: transação curta READ COMMITTED, seleção PENDING/due por índice
(next_attempt_at, created_at, id), FOR UPDATE SKIP LOCKED, token UUID novo por
claim, claimed_by, claimed_until e incremento de attempts. Commit antes de envio.
Batch não supera concorrência; nenhum claim aguarda vaga. Não há mutex global
nem lock SQL durante rede. `attempts` conta claims confirmados, incluindo crash
antes do envio; consultas não contam. Lease sem renovação infinita, dimensionado
para timeout total SQS e margem SQL. SDK faz uma tentativa por claim.

Finalização e retry condicionam eventId/token/PENDING/lease válido. Expiração
permite readquisição e token novo, inclusive com o mesmo owner. Sucesso SQS com
MessageId/SequenceNumber antecede UPDATE PUBLISHED/published_at e limpeza do claim.
Zero updates consulta estado para diagnosticar ALREADY_PUBLISHED/CLAIM_LOST/
LEASE_EXPIRED/MISSING; não presume que o dono antigo persistiu sucesso. Schema
protege envelope histórico e impede alteração de PUBLISHED. Não se apaga Outbox.

Falha transitória aplica backoff exponencial limitado com jitter entre mínimo e
teto; falha permanente aguarda o máximo. Tentativas ilimitadas, sem estado terminal
ou descarte. last_error recebe somente código permitido e next_attempt_at usa
relógio SQL. Falha ao persistir retry/finalização mantém lease recuperável; aceite
SQS seguido de SQL incerto pode causar republicação idêntica. A janela é parte da
semântica at-least-once. Erro de um evento não abandona os demais.

Startup valida configuração/SQL/fila. Diagnóstico periódico registra loop,
dependências, PENDING/leases expirados/lag e contadores locais. SIGTERM interrompe
novas aquisições e drena até prazo; SDK/pool fecham normalmente. Prazo excedido
sai 1, sem confirmação falsa, com recuperação por lease; SIGKILL não depende de
hooks. Readiness da API mantém suas dependências atuais. Configuração completa,
erros recuperáveis e procedimentos pertencem à operação, sem duplicação aqui.

## Eventos de integração (§11)

### Resolução de referências — Task 11

O worker SQL da Task 11 persiste **novos** eventos v1 somente para a transição
terminal: Processed e WalletBalanceChanged quando houver saldo, ou Rejected sem
saldo. Cada novo fato recebe eventId próprio, correlationId da operação original
e occurredAt da resolução sob lock. O fato antigo de pendência não muda. Espera,
replay ou claim perdido não geram eventos. Nenhum novo tipo/versão é necessário.
Idempotência e eventos terminais participam da mesma UnitOfWork financeira;
publicação continua exclusivamente pelo publisher da Task 10. Inbox original
permanece concluída e não precisa ser reaberta. [Contrato](wagering.md#task-11--resolução-de-referências)
e [pipeline HTTP/SQS/worker/publisher real](../task11-pending-report.md).

| Evento mínimo                    | Quando                                                              |
| -------------------------------- | ------------------------------------------------------------------- |
| WagerTransactionProcessed        | Qualquer transação aplicada, inclusive LOSS                         |
| WagerTransactionRejected         | Rejeição por regra de negócio, inclusive referência esgotada (§7.1) |
| WalletBalanceChanged             | Somente quando saldo muda                                           |
| WagerTransactionPendingReference | Referência ausente                                                  |

Envelope é **classe abstrata IntegrationEvent com subclasse concreta por evento**. eventType e version pertencem ao tipo, não a strings soltas no chamador. Campos: eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt, version e data readonly. Serialização da data de ocorrência em ISO-8601; envelope JSON estável/versionável vai no payload da Outbox. Valores monetários em data usam MoneyProps (strings decimais), nunca instância Money.

O exemplo WalletBalanceChanged usa version 1 e data com walletId, transactionId, direction, money, balanceBefore, balanceAfter e walletVersion; não define automaticamente todos os contratos de data dos outros eventos. A saída usa wager-events.fifo conforme a Task 10 abaixo.

### Task 07 — protocolo v1 implementado

As escolhas de payload e metadados abaixo concretizam o escopo autorizado pela Task 07.
Classes e contratos estão em [events.ts](../../src/modules/wagering/public/events.ts)
e [IntegrationEvent](../../src/modules/wagering/public/integration-event.ts).
Cada classe concreta tem construtor privado e factory `create`; `eventType` literal
e `version = 1` pertencem ao tipo. `WagerIntegrationEvent` é a união discriminada;
não há combinação livre de tipo e payload. Não há evento novo para FAILED.

Envelope JSON persistido integralmente em `outbox_messages.payload`:
`{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data }`.
`event_version` físico corresponde a `version`, sem renomear o protocolo do desafio.

| Campo                     | Política implementada                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eventId                   | UUID criado uma vez por ocorrência antes do INSERT; UNIQUE e trigger existentes preservam identidade. Uma tentativa revertida não constitui evento confirmado.                        |
| aggregateId               | transactionId para os três eventos Wagering; walletId para WalletBalanceChanged. Factories conferem a identidade contra data.                                                         |
| correlationId             | ProcessWagerUseCase usa transactionId, determinístico dentro da operação persistida. Permite unir transação, resultado idempotente, ledger e eventos sem campo de transporte novo.    |
| causationId               | Ausente para comando direto. Factories aceitam contexto explícito para futura transição causada por evento; não inventar causa entre eventos irmãos.                                  |
| occurredAt                | Instante da decisão financeira sob lock, o mesmo `at` explícito usado pelo processador/transação/ledger; cópia defensiva de Date e ISO 8601 UTC no JSON. Não é horário de publicação. |
| createdAt / nextAttemptAt | Defaults SQL de inserção, ambos current_timestamp da transação; evento inicialmente elegível. Não há agendamento/retry nesta etapa.                                                   |

Dados comuns dos eventos Wagering: `transactionId`, `providerId`,
`externalTransactionId`, `playerId`, `walletId`, `kind` externo e `money: MoneyProps`.
Não incluem key/hash de idempotência, requisição bruta, credenciais ou erros técnicos.

| eventType (v1)                   | data além dos campos comuns                                                                                                               | aggregateId   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| WagerTransactionProcessed        | `status: "PROCESSED"`, `referenceTransactionId?` quando resolvida; reversões exigem referência interna                                    | transactionId |
| WagerTransactionRejected         | `status: "REJECTED"`, `failureCode` de negócio persistido                                                                                 | transactionId |
| WagerTransactionPendingReference | `status: "PENDING_REFERENCE"`, `referenceExternalTransactionId` ausente no armazenamento de transações                                    | transactionId |
| WalletBalanceChanged             | Sem campos comuns implícitos: somente `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` | walletId      |

| Resultado novo confirmado                                            | Eventos inseridos                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| BET / WIN / REFUND / ROLLBACK PROCESSED com mudança financeira       | WagerTransactionProcessed + WalletBalanceChanged                          |
| LOSS PROCESSED, inclusive zero                                       | Somente WagerTransactionProcessed; sem ledger/versão nova                 |
| REJECTED                                                             | Somente WagerTransactionRejected                                          |
| PENDING_REFERENCE, referência inexistente                            | Somente WagerTransactionPendingReference                                  |
| PENDING, referência encontrada PENDING/PENDING_REFERENCE             | Nenhum; não representa referência inexistente nem processamento concluído |
| Replay de qualquer resultado / conflito de key ou identidade externa | Nenhum; nenhum eventId novo ou timestamp alterado                         |
| Erro técnico / rollback                                              | Nenhum evento confirmado; erro propagado, sem FAILED terminal artificial  |

Validação em execução: UUIDs, textos não vazios/sem NUL/Unicode inválido,
tipo/status/agregado coerentes, Money canônico com duas casas e catálogo de moedas,
versão inteira da wallet e aritmética exata de saldo. Factories copiam somente campos
definidos; dados e objetos monetários são congelados, datas entram/saem como cópias.
O adapter aceita classes validadas e o PostgreSQL reforça UUIDs, objeto JSONB,
versão positiva, unicidade e coerência de status. Não é duplicada toda a validação
de domínio em constraints SQL.

`OutboxRepository.append(readonly WagerIntegrationEvent[])` é uma porta pública de
Wagering. Seu adapter de persistência usa OutboxMessageRow/TransactionSession de
Platform, sem Platform importar negócios. Todos os INSERTs usam a sessão recebida;
sem transação, commit ou retry próprios. Bootstrap compõe a porta no contexto.
Ordem: idempotência/locks → decisão → transação/wallet/ledger → Outbox → resultado
idempotente → commit. Qualquer falha obrigatória reverte tudo, inclusive eventos
já inseridos. [Evidências executáveis](../task07-outbox-report.md).

Evolução: o significado de um par `(eventType, version)` persistido é permanente.
Alterar campos obrigatórios, semântica ou representação exige nova versão e suporte
explícito do consumidor; produtores/consumidores devem planejar coexistência.
Não reconstruir eventos históricos usando o estado atual nem atualizar payloads
antigos para representar nova transição. A resolução de pendência da Task 11 insere
novos fatos e atualiza somente estado/resultado pendente conforme o contrato Wagering,
na mesma transação SQL; o worker está implementado na Task 11.

Contrato do publisher implementado na Task 10: ler o envelope persistido, preservar eventId,
version, dados e correlação em toda republicação; publicar somente após commit.
PENDING/attempts 0/published_at nulo significam intenção durável, não publicação
confirmada. A janela publicar/marcar permite duplicatas: consumidores deverão
deduplicar por eventId estável. A Task 10 concretiza claims/leases, backoff, destino e confirmação incerta;
continua sem garantia de exactly-once delivery.

## Falhas, ACK, redelivery e DLQ (§§3, 10–11)

| Situação                                                   | Garantia explícita / recuperação                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Erro de negócio                                            | Resultado terminal persistido; ACK após commit, sem efeito financeiro da rejeição                             |
| Erro transitório PostgreSQL/SQS                            | Retry com backoff; sem ACK antes de confirmar persistência                                                    |
| Erro permanente                                            | Encaminhamento DLQ; respeitar limite de tentativas antes da DLQ; detalhes de classificação/registro pendentes |
| Crash antes do commit                                      | Nenhum efeito parcial confirmado; redelivery permite nova tentativa                                           |
| Crash depois do commit e antes do ACK                      | Redelivery consulta Inbox/idempotência e não duplica efeitos                                                  |
| Crash depois do commit e antes de publicar                 | Outra instância recupera Outbox e publica                                                                     |
| Publicação confirmada externamente, marcação local incerta | Republicação possível com mesmo eventId; duplicata segura                                                     |
| SIGTERM                                                    | Concluir mensagens em andamento ou devolver visibilidade; não confirmar trabalho incompleto                   |

Recebimentos repetidos não justificam crédito/débito/evento financeiro novos. Falhas e recuperação da DLQ devem ser diagnosticáveis; estratégia de redrive, configurações de visibilidade/tentativas e filas de eventos precisam de decisão. A expiração da deduplicação FIFO não substitui o banco.

## Evidências e pendências (§§12–13)

[Testes de entrada](../../test/sqs-consumer.test.ts), [Inbox SQL](../../test/inbox.test.ts),
[SQS real](../../test/sqs.test.ts) e [Docker/SIGTERM](../../test/consumer-docker.test.ts)
exercitam PostgreSQL 18.3 e LocalStack 4.14.0 descartáveis, três processos Bun,
atomicidade, HTTP ↔ SQS, redelivery/crashes, indisponibilidade e redrive. Publicadores concorrentes e recuperação estão implementados na
[Task 10](../outbox-publisher.md). Métricas
completas/exportação continuam pendentes; diagnósticos JSON do consumer incluem
status, duplicatas, retries, receive count, falha de ACK/visibilidade e latência,
sem payload completo/credenciais. [Relatório](../task09-sqs-report.md).
