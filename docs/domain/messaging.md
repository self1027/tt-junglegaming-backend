# Messaging: entrada, eventos e recuperação

Requisitos **explícitos** dos §§3, 5, 6.0, 6.5, 7.1 e 9–13 de [challenge.md](../challenge.md), fonte primária imutável. Fronteiras/processos são decisões de [ARCHITECTURE.md](../../ARCHITECTURE.md). A Task 07 implementa eventos tipados e inserção transacional na Outbox pelo ProcessWagerUseCase. Transportes, Inbox e publicação continuam planejados.

## Entradas HTTP e SQS (§§9–10)

HTTP valida/adapta a entrada e chama ProcessWagerUseCase, retornando resultado síncrono do caso de uso, inclusive status pendente quando aplicável. Endpoints, header e categorias HTTP ficam em [requirements.md](../requirements.md); hash/replay em [Wagering](wagering.md). HTTP também registra Outbox atomicamente, sem publicar antes de commit.

Entrada SQS FIFO: `wager-transactions.fifo`, com `wager-transactions-dlq.fifo`. O envelope de entrada é `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`; data contém providerId, externalTransactionId, idempotencyKey, playerId, walletId, roundId, gameId, kind, money e referência quando exigida. occurredAt é timestamp conforme exemplo ISO-8601. A identidade messageId do envelope e o identificador nativo do broker não devem ser confundidos; o mapeamento definitivo precisa ser documentado.

Consumer separa recebimento de processamento: adapta mensagem, deduplica Inbox, chama **o mesmo use case HTTP**, confirma transação e só então ACK (remoção da mensagem). Fila é canal interno confiável para autenticação, mas provider continua validado pelo domínio (§2). OPENING externo é proibido (§6.3).

## Inbox e atomicidade (§§6.5, 10–11)

Deduplicação persistente por `(consumerName, messageId)`, sem depender somente do FIFO ou memória. Modelo de referência registra payloadHash, receivedAt, processedAt e transição markProcessed; usar factories/rehydrate conforme §6.0.

Inbox, idempotência/transação, saldo, ledger e Outbox aplicáveis participam da **mesma transação SQL**. O significado preciso de Inbox processada para resultado pendente e a reação a mesmo messageId com hash divergente estão pendentes; não inventar ACK antecipado ou descartar divergência silenciosamente.

Inbox deduplica entrega do transporte. Idempotência de negócio identifica operação/payload e recupera resultado original; mensagens distintas podem representar a mesma operação. Ambas devem funcionar sob concorrência e reinicialização.

## Outbox e publicação (§§6.5, 11)

Evento confirmado é persistido com efeitos financeiros no commit. Worker publica depois, com múltiplos publishers concorrentes, sem perder eventos nem duplicá-los indefinidamente. Modelo de referência inclui id, aggregateId, eventType, payload readonly, occurredAt, attempts, nextAttemptAt e publishedAt; consultas pending/due e transições de publicação/retry com backoff.

Falha entre publicação e marcação pode causar republicação: preservar eventId estável e envelope persistido; consumidor tolera duplicatas. A entrega é **at-least-once**, não exactly-once. Claims, leases/locks e política exata de backoff/limites ainda não escolhidos. Outbox Publisher e Pending Reference Processor são componentes distintos; o segundo resolve referências com política descrita em [Wagering](wagering.md).

## Eventos de integração (§11)

| Evento mínimo                    | Quando                                                              |
| -------------------------------- | ------------------------------------------------------------------- |
| WagerTransactionProcessed        | Qualquer transação aplicada, inclusive LOSS                         |
| WagerTransactionRejected         | Rejeição por regra de negócio, inclusive referência esgotada (§7.1) |
| WalletBalanceChanged             | Somente quando saldo muda                                           |
| WagerTransactionPendingReference | Referência ausente                                                  |

Envelope é **classe abstrata IntegrationEvent com subclasse concreta por evento**. eventType e version pertencem ao tipo, não a strings soltas no chamador. Campos: eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt, version e data readonly. Serialização da data de ocorrência em ISO-8601; envelope JSON estável/versionável vai no payload da Outbox. Valores monetários em data usam MoneyProps (strings decimais), nunca instância Money.

O exemplo WalletBalanceChanged usa version 1 e data com walletId, transactionId, direction, money, balanceBefore, balanceAfter e walletVersion; não define automaticamente todos os contratos de data dos outros eventos. Destinos/filas de eventos e seus ajustes ainda estão pendentes.

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
antigos para representar nova transição. Uma futura resolução de pendência insere
novos fatos e atualiza somente estado/resultado pendente conforme o contrato Wagering,
na mesma transação SQL; o worker não está implementado.

Contrato mínimo do futuro publisher: ler o envelope persistido, preservar eventId,
version, dados e correlação em toda republicação; publicar somente após commit.
PENDING/attempts 0/published_at nulo significam intenção durável, não publicação
confirmada. A janela publicar/marcar permite duplicatas: consumidores deverão
deduplicar por eventId estável. Claims/leases, backoff, destinos, confirmação incerta
e testes SQS continuam pendentes; não há garantia end-to-end ou exactly-once delivery.

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

## Evidências futuras (§§12–13)

Validar com PostgreSQL e LocalStack/MiniStack reais em containers: atomicidade incluindo Inbox/Outbox, redelivery, retry/DLQ, dois publishers concorrentes e reinício/crash nas janelas descritas. Pelo menos três processos quando a garantia avaliada depender disso. Métricas/correlação mínimas estão em [requirements.md](../requirements.md); não registrar payload financeiro completo ou segredos para diagnosticar.
