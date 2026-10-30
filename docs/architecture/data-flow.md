# Fluxos e fronteiras de commit

Os diagramas em texto são versionáveis e legíveis sem renderer externo. As setas
representam chamadas ou transferência de trabalho; as linhas de commit indicam
quando o próximo processo pode observar o resultado. Componentes são os da
[composição atual](../../src/bootstrap/).

## Visão geral

```text
Provedor -- HTTP --> API --------------------+
                                            |
Provedor -- SQS comandos --> Consumer -------+--> ProcessWagerUseCase
                                                       |
                                          PostgreSQL: commit financeiro
                                            /          |          \
                                        Wallet       Ledger       Outbox
                                                                  |
                                                            Publisher
                                                                  |
                                                           SQS eventos

Pending Reference Worker --> ResolvePendingWagerUseCase --> PostgreSQL
                               (mesmo motor financeiro)
```

Consumer, publisher e worker são processos independentes. Não há chamada do
publisher ao processador nem início de workers pelo HTTP. A referência pendente
é descoberta no PostgreSQL, sem consumir a fila de eventos.

## Entrada HTTP

```text
POST /wagering/transactions
  -> pipe/header: validar contrato
  -> prepareWager: capturar campos e calcular hash
  -> UnitOfWork BEGIN
       idempotência -> identidade externa -> wallet FOR UPDATE
       referência/histórico -> processWager
       WagerTransaction -> saldo/ledger aplicáveis -> Outbox -> resultado
     COMMIT
  -> log/métricas e resposta 200 / 202 / 422
```

Replay pode sair pelo resultado idempotente sem adquirir wallet ou construir
eventos. Erro reverte e vai ao filtro HTTP. A resposta perdida depois do commit
não desfaz o movimento; retry com a mesma identidade recupera o resultado.
Fontes: [use case](../../src/modules/wagering/application/process-wager.use-case.ts),
[filtro](../../src/bootstrap/http-error.filter.ts) e
[interceptor](../../src/bootstrap/wager-diagnostics.interceptor.ts).

## SQS e Inbox

```text
ReceiveMessage (ReceiptHandle atual)
  -> parser -> comando + identidade/hash Inbox
  -> UnitOfWork BEGIN
       Inbox claim
       -> ProcessWagerUseCase: idempotência/locks/efeitos/Outbox/resultado
       -> Inbox complete
     COMMIT
  -> diagnóstico committed
  -> DeleteMessage (ACK)
```

Duplicata Inbox ignora o motor, confirma a participação e então recebe ACK.
PENDING e REJECTED duravelmente aceitos também recebem ACK. Erro sem commit não
recebe ACK; visibilidade/redrive governam retry/DLQ. Crash depois de COMMIT e antes
de DeleteMessage redelivera sem duplicar efeitos. Fontes:
[handler](../../src/modules/wagering/adapters/sqs/wager-handler.ts),
[Inbox](../../src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts)
e [consumer](../../src/platform/messaging/reliable-consumer.ts).

## Outbox e publisher

```text
Commit financeiro inclui Outbox PENDING
  -> claim BEGIN: SKIP LOCKED + token/lease/attempts -> COMMIT
  -> SendMessage: envelope persistido, eventId estável
  -> aceite SQS com MessageId/SequenceNumber
  -> UPDATE PUBLISHED se token/PENDING/lease válido
```

Não há transação SQL aberta durante SendMessage. Crash antes do envio deixa lease
para outro publisher; aceite SQS seguido de crash antes do UPDATE permite
republicação. Fencing impede o dono antigo de finalizar outro claim, sem impedir
uma duplicata já enviada. Fontes: [publisher](../../src/platform/messaging/outbox-publisher.ts),
[store](../../src/platform/persistence/mikro-orm-outbox-store.ts),
[adapter SQS](../../src/modules/wagering/adapters/sqs/sqs-event-publisher.ts).

## Referências pendentes

```text
PENDING / PENDING_REFERENCE com referência externa e due
  -> claim curto BEGIN: SKIP LOCKED + token/lease/attempts -> COMMIT
  -> resolução BEGIN
       lock idempotência -> identidade externa -> wallet -> linha/claim
       reler referência/histórico e TTL -> processWager
       se terminal: saldo/ledger + resultado idempotente + novos fatos Outbox
       finish WagerTransaction com token/estado/lease válido
     COMMIT
  -> diagnóstico pending_attempt
```

Espera agenda próxima tentativa sem mudar o snapshot aceito ou criar evento de
polling. Fencing final perdido reverte inclusive saldo/ledger já escritos naquela
transação. Erro técnico agenda retry isolado após rollback; se esse retry falhar,
o lease expira. Fontes: [resolver](../../src/modules/wagering/application/resolve-pending-wager.use-case.ts),
[worker](../../src/modules/wagering/adapters/worker/pending-reference-worker.ts),
[finish SQL](../../src/modules/wagering/adapters/persistence/mikro-orm-pending.repository.ts).

## Máquina de estados

```text
criação -> PENDING -----------------------> PROCESSED
              |                                (terminal)
              +-> PENDING_REFERENCE ------> PROCESSED
              |           |
              +-----------+---------------> REJECTED
              |           |                    (terminal)
              +-----------+---------------> FAILED
                                               (terminal)
```

As setas para FAILED representam fail(code) explícito do domínio, testado em
unidade; nenhum processo classifica erro técnico genérico nesse destino. Polling
em espera mantém estado, sem seta PENDING_REFERENCE para PENDING. Reidratação e
replay não são transições. O [contrato de Wagering](../domain/wagering.md#estados-e-transições)
define condições e códigos; o [runbook](../operations/failure-recovery.md) descreve
ações após falha.
