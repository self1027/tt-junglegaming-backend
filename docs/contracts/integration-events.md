# Eventos de integração

Fonte executável: [IntegrationEvent](../../src/modules/wagering/public/integration-event.ts),
[quatro subclasses](../../src/modules/wagering/public/events.ts) e
[matriz de emissão](../../src/modules/wagering/application/wager-events.ts).
O envelope é persistido integralmente em Outbox e publicado em `wager-events.fifo`.

## Envelope e metadados

`IntegrationEvent` é abstrata. Cada subclasse tem construtor privado, factory
create, eventType literal e version 1. WagerIntegrationEvent é união discriminada,
sem combinação livre de tipo/payload. ToJSON retorna:
`{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data }`.
A coluna event_version corresponde a version; payload SQL contém o envelope
completo. Não renomear esses campos públicos para eventVersion/payload.

| Campo         | Contrato                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| eventId       | UUID criado uma vez por fato antes do INSERT; rollback não constitui evento confirmado                                             |
| aggregateId   | transactionId nos eventos Wagering; walletId em WalletBalanceChanged                                                               |
| correlationId | transactionId da operação persistida, inclusive resolução posterior                                                                |
| causationId   | Opcional; ausente nos comandos diretos/resolução atual. Factories aceitam causa explícita; não inventar causa entre eventos irmãos |
| occurredAt    | Instante explícito da decisão sob lock, comum à transação/ledger; ISO-8601 UTC. Não é horário de envio                             |
| version       | 1 nas quatro classes atuais                                                                                                        |
| data          | JSON estável, MoneyProps com amount string; nunca instância Money ou bigint bruto                                                  |

Created_at/next_attempt_at são metadados técnicos SQL de inserção/agendamento, fora
do envelope. Republicação conserva identidade, ocorrência e dados históricos.

## Payloads v1

Campos comuns dos três eventos Wagering: transactionId, providerId,
externalTransactionId, playerId, walletId, kind externo e money MoneyProps.
Não incluem key/hash, requisição bruta, credenciais ou texto de erros técnicos.

| eventType                        | Data além dos campos comuns                                                                                                     | aggregateId   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| WagerTransactionProcessed        | status PROCESSED; referenceTransactionId quando resolvida, obrigatório para reversões                                           | transactionId |
| WagerTransactionRejected         | status REJECTED; failureCode persistido                                                                                         | transactionId |
| WagerTransactionPendingReference | status PENDING_REFERENCE; referenceExternalTransactionId solicitado e ausente no lookup                                         | transactionId |
| WalletBalanceChanged             | Não usa campos comuns implícitos: somente walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion | walletId      |

```json
{
	"eventId": "0192f299-345e-7e38-af88-e43f851a819d",
	"eventType": "WalletBalanceChanged",
	"aggregateId": "0192f291-27dd-7d3f-8071-5f8685deef37",
	"correlationId": "0192f298-345e-7e38-af88-e43f851a819d",
	"occurredAt": "2026-10-29T15:00:00.000Z",
	"version": 1,
	"data": {
		"walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
		"transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
		"direction": "DEBIT",
		"money": { "amount": "25.00", "currency": "BRL" },
		"balanceBefore": { "amount": "100.00", "currency": "BRL" },
		"balanceAfter": { "amount": "75.00", "currency": "BRL" },
		"walletVersion": 2
	}
}
```

Factories validam UUIDs/textos, agregado/tipo/status, Money canônico, moedas,
versão da wallet (2 a 2147483647) e equação do movimento. Copiam somente campos
previstos, congelam dados monetários e protegem datas. O adapter de publicação
revalida envelope/metadados e exige igualdade integral, recusando campos extras
ou normalização silenciosa de fatos persistidos.

## Quando emitir

| Resultado novo confirmado                       | Eventos                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| BET/WIN/REFUND/ROLLBACK PROCESSED com movimento | WagerTransactionProcessed e WalletBalanceChanged |
| LOSS PROCESSED, inclusive zero                  | Somente WagerTransactionProcessed                |
| REJECTED                                        | Somente WagerTransactionRejected                 |
| Referência ausente, PENDING_REFERENCE           | Somente WagerTransactionPendingReference         |
| Referência encontrada não terminal, PENDING     | Nenhum                                           |
| Replay, conflito, espera ou claim perdido       | Nenhum                                           |
| Erro técnico/rollback                           | Nenhum fato confirmado; sem FAILED artificial    |
| OPENING                                         | Nenhum evento Wagering                           |

Resolução terminal pelo worker cria novos fatos com novos eventIds e occurredAt
da resolução. O evento anterior de pendência permanece intacto. Não há evento
novo para FAILED. Inserção e efeitos financeiros compartilham commit; publicação
segue o [protocolo Messaging](../domain/messaging.md#publicação-recuperável).

## Compatibilidade e entrega

Significado de (eventType,version) persistido é permanente. Mudança de campos
obrigatórios, semântica ou representação exige versão nova e suporte explícito
com coexistência. O publisher atual recusa tipos/versões desconhecidos como
INVALID_EVENT e mantém retry recuperável, sem editar fatos antigos.

MessageDeduplicationId = eventId; MessageGroupId = data.walletId nos quatro tipos.
FIFO ordena chegada ao grupo, sem ordem de commit ou de eventos irmãos entre
publishers. Deduplicação FIFO dura cinco minutos; consumidor downstream precisa
de deduplicação persistente por eventId além dessa janela. WalletVersion, quando
presente, permite interpretar versões; não cria ordenação global. Nenhum consumer
downstream foi entregue.

[Contratos](../../test/wager-events.test.ts), [serialização](../../test/publisher.test.ts),
[precisão/atomicidade SQL](../../test/process-wager-persistence.test.ts) e
[pipeline real](../../test/publisher-pipeline.test.ts) verificam esses limites.
