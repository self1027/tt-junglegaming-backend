# Messaging: entrada, eventos e recuperação

Requisitos **explícitos** dos §§3, 5, 6.0, 6.5, 7.1 e 9–13 de [challenge.md](../challenge.md), fonte primária imutável. Fronteiras/processos são decisões de [ARCHITECTURE.md](../../ARCHITECTURE.md). Componentes abaixo estão planejados, não implementados.

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
