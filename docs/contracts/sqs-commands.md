# Comandos SQS

Fila de entrada: `wager-transactions.fifo`; DLQ:
`wager-transactions-dlq.fifo`. A fila de eventos é outra fila. O consumer usa
[ProcessWagerUseCase](../../src/modules/wagering/application/process-wager.use-case.ts),
compartilhado com HTTP, por meio do [parser](../../src/modules/wagering/adapters/sqs/wager-message.ts).

## Envelope

```json
{
	"messageId": "msg-provider-a-transaction-123",
	"type": "WagerTransactionRequested",
	"occurredAt": "2026-10-29T15:00:00.000Z",
	"data": {
		"providerId": "provider-a",
		"externalTransactionId": "transaction-123",
		"idempotencyKey": "provider-a:transaction-123",
		"walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
		"playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
		"roundId": "round-987",
		"gameId": "fortune-chimp",
		"kind": "BET",
		"money": { "amount": "25.00", "currency": "BRL" }
	}
}
```

Somente messageId, type, occurredAt e data são aceitos no envelope. Type é literal;
não há campo version nessa entrada. OccurredAt exige data/hora ISO-8601 válida e
fuso explícito (Z ou offset); datas impossíveis são rejeitadas. Em data, os campos
acima são obrigatórios; referenceExternalTransactionId é adicional e obrigatório
para REFUND/ROLLBACK. Regras de referência pertencem a [Wagering](../domain/wagering.md).

WalletId é UUID; identidades externas são texto não vazio, sem NUL/Unicode
malformado. Money exige string decimal com duas casas e moeda aceita por Money.
Number, escala inválida, negativos, OPENING e campos desconhecidos são recusados.
Data.money vira command.amount, sem conversão numérica. Data.idempotencyKey é
preservada; não há header HTTP nesse transporte.

## Identidades e compatibilidade

MessageId do envelope deve ser globalmente único por consumer e estável no retry.
Use UUID ou namespace de produtor. O ID nativo SQS não substitui esse campo.
`MessageDeduplicationId` deve ser estável para o mesmo envio e
`MessageGroupId` recomendado é walletId canônico. Grupo incorreto não remove os
locks PostgreSQL; não existe ordem global entre grupos.

Reenviar o mesmo envelope preserva todos os campos, inclusive occurredAt. Mudar o
corpo com o mesmo messageId conflita com o hash Inbox. Nova mensagem para a mesma
operação pode ter outro messageId, mas mantém a identidade de negócio/key e cai
na idempotência financeira. [Hash Inbox e ACK](../domain/messaging.md#inbox-e-ack).

O parser atual usa allowlist e recusa campos desconhecidos. Ampliar o contrato
exige coordenação de produtores/consumers; não se presume compatibilidade com
campos extras. [Testes de contrato](../../test/sqs-input.test.ts),
[transporte real](../../test/sqs.test.ts) e [consumer](../../test/sqs-consumer.test.ts).
[Envio executável e recuperação](../operations/consumer.md).
