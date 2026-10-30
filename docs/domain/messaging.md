# Messaging: Inbox, ACK e publicação recuperável

Entrada e saída são at-least-once. O banco coordena os efeitos financeiros e
registra a intenção de publicar no mesmo commit; SQS não participa da transação SQL.
[Envelope de comandos](../contracts/sqs-commands.md) e
[eventos versionados](../contracts/integration-events.md) são os contratos externos.

## Inbox e ACK

Deduplicação de transporte usa `(consumerName, messageId)` do envelope, com
`consumerName = wagering-v1`. O ID nativo do broker e ReceiptHandle não são
identidade financeira. Mensagens diferentes podem representar a mesma operação;
a idempotência de [Wagering](wagering.md#entrada-saída-e-identidade) continua necessária.

O [parser](../../src/modules/wagering/adapters/sqs/wager-message.ts) adapta data.money
para command.amount e calcula SHA-256 UTF-8 do JSON explícito, ordenado por chaves:
`data`, `messageId`, `occurredAt`, `type`. Data contém `externalTransactionId`,
`gameId`, `idempotencyKey`, `kind`, `money`, `playerId`, `providerId`,
`referenceExternalTransactionId`, `roundId`, `walletId`. Money é canônico; walletId
fica minúsculo; referência ausente/null vira null. Texto e representação occurredAt
são preservados. Alterar timestamp do mesmo envelope conflita mesmo se representar
o mesmo instante. Esse hash inclui transporte/key e difere do hash de negócio.

[InboxRepository](../../src/modules/wagering/public/inbox.ts) expõe claim/complete.
O [adapter](../../src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts)
usa INSERT ON CONFLICT e FOR UPDATE, compara hash/estado e participa da mesma
TransactionSession financeira. Ordem: Inbox, idempotência, identidade externa,
wallet, referências/histórico. Não há commit próprio ou lease Inbox persistente.

RECEIVED novo existe dentro da transação; rollback/crash elimina claim e efeitos.
RECEIVED legado confirmado pode ser retomado sob lock. PROCESSED/hash igual retorna
duplicata antes do motor. Attempts conta participações confirmadas, inclusive
duplicatas; não conta recebimentos/rollbacks. Erros de tentativas revertidas ficam
nos logs e no receive count/DLQ do broker, sem commit técnico separado.

| Resultado                                                   | Persistência e transporte                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| PROCESSED, REJECTED, PENDING, PENDING_REFERENCE             | Inbox PROCESSED no mesmo commit; depois ACK                              |
| Duplicata Inbox/hash igual                                  | Commit da participação; depois ACK; sem novo efeito                      |
| JSON/envelope/identidade/Money inválidos                    | Sem processamento/ACK; redrive nativa                                    |
| Conflito Inbox/key/identidade externa ou wallet inexistente | Permanente, rollback, sem ACK; redrive                                   |
| SQL/conexão/deadlock/erro inesperado ou key IN_PROGRESS     | Transitório para transporte; rollback, retry por visibilidade/redelivery |
| DeleteMessage falho/incerto                                 | Commit preservado; próximo recebimento usa Inbox                         |

Inbox PROCESSED significa entrada aceita duravelmente, inclusive pendência. O
worker SQL resolve a referência depois; redelivery não repete esse trabalho.
A Promise do use case só resolve após commit; [ReliableConsumer](../../src/platform/messaging/reliable-consumer.ts)
então tenta DeleteMessage. Acknowledgement não é coordenado atomicamente com SQL;
crash entre os dois exige deduplicação persistente.

O consumer recebe uma mensagem por chamada, com pollers concorrentes. Isso evita
que poison gaste tentativas de sucessoras no mesmo batch. Visibilidade é renovada
até o deadline; perder renovação/prazo adia ACK mesmo se o commit ocorreu.
Falha usa backoff `min(visibilitySeconds, 2^receiveCount)`, com expoente limitado a 8.
SQS limita entregas pela redrive; erros permanentes também permanecem sem ACK até
chegar à DLQ. Receive count é aproximado e não equivale a attempts SQL.
[Parâmetros, sinais e recuperação](../operations/consumer.md).

## Outbox transacional

[OutboxRepository](../../src/modules/wagering/public/events.ts) recebe eventos
tipados. O [adapter de inserção](../../src/modules/wagering/adapters/persistence/mikro-orm-outbox.repository.ts)
persiste o envelope completo JSONB na mesma sessão de transação/saldo/ledger/Inbox/
idempotência, antes da conclusão idempotente. Replay retorna sem construir eventos.
Falha em qualquer INSERT ou etapa posterior reverte os eventos já inseridos.

PENDING/attempts zero/published_at nulo é intenção durável. O publisher lê somente
registros confirmados. OPENING não produz eventos Wagering. Resolução de referência
produz novos fatos terminais; polling e claim perdido não produzem fatos. A
[matriz de emissão](../contracts/integration-events.md#quando-emitir) é a fonte dos
quatro eventos e dos casos sem evento.

## Publicação recuperável

[OutboxPublisher](../../src/platform/messaging/outbox-publisher.ts) depende de
OutboxStore/EventPublisher técnicos. O adapter SQS do módulo valida contratos; a
Platform não importa negócios. Aquisição SQL usa FOR UPDATE SKIP LOCKED numa
transação curta, com novo token por claim, owner, lease e incremento de attempts.
Commit libera locks antes da rede. Batch não supera concorrência; claims não
aguardam vaga numa fila local. [SQL e integridade](../persistence.md#claims-e-fencing).

O publisher envia o envelope histórico, sem recalcular estado. Confirmação SQS com
MessageId/SequenceNumber antecede UPDATE PUBLISHED e limpeza do claim. Conclusão ou
retry exige token, PENDING e lease válido no relógio SQL. Atualização zero distingue
ALREADY_PUBLISHED, CLAIM_LOST, LEASE_EXPIRED e MISSING. O dono antigo não confirma
ou libera o claim de outro processo. Leases não são renovados indefinidamente.

Falha de envio agenda backoff exponencial com jitter entre mínimo e teto; erro
permanente aguarda o teto. Attempts conta claims confirmados, inclusive crash antes
de enviar. Tentativas não são esgotadas nem descartadas. Falha ao persistir retry/
finalização deixa o lease recuperável. Códigos permitidos e ações de reparação
ficam no [runbook do publisher](../operations/publisher.md).

Se SQS aceitar e o processo morrer antes de PUBLISHED, outro processo pode enviar
o mesmo evento. Fencing protege SQL, sem desfazer um envio já aceito. EventId e
envelope permanecem estáveis; consumidor posterior precisa deduplicar por eventId.
Não há consumer downstream implementado ou promessa de exactly-once delivery.
FIFO ordena chegada por grupo, sem ordenar commits financeiros ou eventos irmãos
entre publishers concorrentes. A janela FIFO de cinco minutos não é garantia
permanente de deduplicação.

## Verificação e limites

[Inbox real](../../test/inbox.test.ts), [consumers SQS](../../test/sqs-consumer.test.ts),
[publishers concorrentes](../../test/publisher-pipeline.test.ts) e
[recuperação](../../test/publisher-recovery.test.ts) exercitam os pontos de commit,
ACK e aceite incerto em containers/processos reais. Os
[cenários distribuídos](../testing/distributed-scenarios.md) indicam barreiras e
assertivas; contagens/datas pertencem ao relatório da execução.

Retenção do broker é limitada. O ambiente LocalStack não tem volume persistente;
recriá-lo perde mensagens, inclusive as já PUBLISHED, sem republicação automática.
Nenhuma garantia de durabilidade cobre remoção administrativa dos dados ou perda
do armazenamento PostgreSQL. [Recuperação operacional](../operations/failure-recovery.md).
