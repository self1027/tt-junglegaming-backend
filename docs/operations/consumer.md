# Operação SQS FIFO e consumer

O [contrato SQS](../contracts/sqs-commands.md) define o envelope do produtor;
[Messaging](../domain/messaging.md#inbox-e-ack) define Inbox, ACK e redelivery.
Este processo recebe comandos. [Publisher](publisher.md) envia os eventos;
[worker SQL](pending-worker.md) resolve referências pendentes.

## Ambiente local

Bun 1.4.4 e Docker Compose, com [.env.example](../../.env.example) copiado para .env.
As credenciais `test` são exclusivas do emulador. Nunca as configure na AWS real.

```sh
docker compose --project-name dwp --profile sqs up -d --wait
bun run db:migrate
bun run sqs:provision
bun run dev
# Outro terminal, no mesmo checkout/ambiente:
bun run consumer
```

O perfil sqs adiciona LocalStack 4.14.0 pinado por digest, com porta de loopback
4566 e sem volume persistente. PostgreSQL mantém o volume existente. Não há nomes
globais de containers. Filas locais são descartadas ao recriar o emulador;
provisione novamente. O procedimento não pretende emular a durabilidade da AWS.
Testes usam projetos/portas dinâmicos e removem somente seus próprios recursos.

`sqs:provision` é explícito, exige endpoint customizado e respeita visibility e
maxReceiveCount do ambiente. Cria também a saída `wager-events.fifo` e mantém `wager-transactions.fifo` e
`wager-transactions-dlq.fifo`, sem content-based dedup, com retenções respectivas
de 4 e 14 dias, long poll 20s, redrive para a DLQ e permissão byQueue da origem.
Não chama esse script em produção. API/consumer nunca criam filas no startup.

```sh
bun run build
bun run start
bun run consumer:start
```

Os dois últimos comandos executam processos separados. A API não inicia polling.
Para parar o ambiente local: `docker compose --project-name dwp --profile sqs down`;
isso preserva o volume PostgreSQL. Não use down --volumes no banco do desenvolvedor.

## Configuração

| Variável                                                      | Default / validação                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| AWS_REGION                                                    | Obrigatória; região AWS                                                    |
| AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN | Cadeia padrão do SDK; omitir credenciais estáticas na AWS quando usar role |
| SQS_ENDPOINT                                                  | Opcional; URL HTTP(S) do emulador, ausente em produção                     |
| SQS_QUEUE_URL / SQS_DLQ_URL                                   | Obrigatórias no consumer, URLs FIFO distintas                              |
| SQS_WAIT_SECONDS                                              | 20; inteiro 0–20                                                           |
| SQS_VISIBILITY_SECONDS                                        | 60; inteiro 1–43200                                                        |
| SQS_BATCH_SIZE                                                | 1; valores maiores recusados para proteger sucessoras da redrive           |
| SQS_CONCURRENCY                                               | 4; inteiro 1–100, número de pollers/recebimentos em andamento por processo |
| SQS_PROCESSING_MS                                             | 120000; inteiro 1000–3600000, limite de extensão/ACK e transação SQL       |
| SQS_SHUTDOWN_MS                                               | 30000; inteiro 1–3600000                                                   |
| SQS_MAX_RECEIVE_COUNT                                         | 5; inteiro 1–1000, deve corresponder à política provisionada               |
| POSTGRES_*                                                    | Mesma configuração da API no [README](../../README.md)                     |

Configuração inválida aborta startup. API admite SQS ausente e nesse caso sinaliza
not_configured/503; quando configurado, também valida as opções. Cada poller pede
uma mensagem: SQS preserva o grupo entre consumers. Não há prefetch de sucessoras
que gastaria tentativas sem execução após uma falha. O custo é mais chamadas ao
broker; o limite de concorrência mantém grupos distintos paralelos. Adeque pool
e concorrência à contenção real; FIFO não substitui locks financeiros.

SDK v3 modular, sem credenciais no código. ReceiveMessage tem deadline externo
de long poll + 5s e cancelamento de shutdown; operações de ACK/visibilidade têm
5s, readiness 3s. Falhas de polling usam backoff 1–30s. Retry financeiro ocorre
por redelivery, nunca por repetição HTTP automática. Detalhes de visibilidade,
tentativas, hashes, estados e ACK pertencem ao contrato Messaging.

## Exemplo de envio reproduzível

Crie uma wallet pelos [exemplos HTTP](../contracts/http.md#exemplos-curl-reproduzíveis).
Copie o JSON do [envelope SQS](../contracts/sqs-commands.md#envelope) para
message.json e substitua walletId/playerId pelos valores criados. Use identidade
externa/key/messageId novos se já executou o exemplo HTTP. Preserve o corpo e
messageId nos retries do mesmo envio.

No comando abaixo, substitua `--message-group-id` pelo `data.walletId` e
`--message-deduplication-id` pelo `messageId` de message.json. Ao trocar esses
campos no arquivo, atualize também os argumentos correspondentes. Reutilizar o
deduplication ID para outra mensagem pode suprimi-la durante a janela FIFO,
mesmo quando SendMessage retorna sucesso.

```sh
docker compose --project-name dwp --profile sqs cp message.json localstack:/tmp/message.json
docker compose --project-name dwp --profile sqs exec localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --message-body file:///tmp/message.json --message-group-id 0192f291-27dd-7d3f-8071-5f8685deef37 --message-deduplication-id msg-provider-a-transaction-123
```

O JSON usa apenas strings monetárias. IDs de exemplo não criam wallet. Após o
ACK, consulte a transação pelo provider/ID externo, o ledger e reconciliação.
Execute `bun run publisher` em outro terminal para publicar Outbox confirmada.
Observe a fila de saída:

```sh
docker compose --project-name dwp --profile sqs exec localstack awslocal sqs receive-message --queue-url http://localhost:4566/000000000000/wager-events.fifo --wait-time-seconds 10 --max-number-of-messages 10
```

Esse comando inspeciona mensagens e altera temporariamente sua visibilidade, sem
apagá-las. O body é o [evento persistido](../contracts/integration-events.md).
Uma referência pendente só produzirá o fato terminal depois do worker SQL.

## Docker e sinais

```sh
docker build -t distributed-wagering-processor .
docker run --rm --name dwp-consumer --network dwp_default --env-file .env -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 -e SQS_ENDPOINT=http://localstack:4566 -e SQS_QUEUE_URL=http://localstack:4566/000000000000/wager-transactions.fifo -e SQS_DLQ_URL=http://localstack:4566/000000000000/wager-transactions-dlq.fifo distributed-wagering-processor bun dist/main.consumer.js
# Outro terminal:
docker stop --time 35 dwp-consumer
```

A API usa a mesma rede/overrides, porta 3000 publicada, e comando padrão da imagem.
O prazo externo do orquestrador deve exceder SQS_SHUTDOWN_MS. SIGTERM/SIGINT
cancelam os long polls; operações iniciadas podem confirmar/ACK dentro do prazo.
Ao excedê-lo, o processo encerra com 1 e redelivery é a recuperação. SIGKILL
não executa hooks; o banco libera/reverte transações pela desconexão.

## Saúde e diagnóstico

`GET /health/live`: processo HTTP vivo, sem dependências. `/health/ready` retorna
200 somente com PostgreSQL e filas alcançáveis/configuradas; 503 identifica down
ou not_configured. GetQueueAttributes verifica FIFO, ARN de destino, maxReceiveCount
e RedriveAllowPolicy (allowAll/default ou byQueue contendo a origem). Nunca recebe
nem apaga mensagens. Acessibilidade não atesta permissões de receber/apagar;
o consumer precisa das permissões IAM ReceiveMessage/DeleteMessage/
ChangeMessageVisibility e GetQueueAttributes nas filas pertinentes.

Consumer não abre HTTP. consumer_ready confirma checks iniciais. Logs de commit,
ACK, falha e retry identificam a etapa; committed antecede a tentativa de ACK,
enquanto acked confirma resposta SQS. Há medição de resultados/duplicatas/latência,
retries e profundidade aproximada da DLQ por checks no polling. Nomes e limites
estão em [observabilidade](observability.md); não há exporter agregado.

Para DLQ, inspecione atributos/contagem e mensagens com ferramenta operacional;
não as exclua antes de registrar diagnóstico e decisão de recuperação. O corpo
original permanece na DLQ. Verifique Inbox/idempotência/resultado antes de redrive.
Mensagens válidas com falha transitória podem ser reenviadas após restaurar a
dependência, mantendo identidades de negócio/envelope; correção de corpo exige
novo messageId e análise do conflito de negócio. Não há redrive automático.
Uma interrupção longa pode esgotar maxReceiveCount também para dados válidos.

## Validação

```sh
bun test test/sqs-input.test.ts test/consumer.test.ts
bun test test/inbox.test.ts test/sqs.test.ts
bun test test/sqs-consumer.test.ts
bun test test/consumer-docker.test.ts
```

Todos integram `bun run test`; os dois últimos exigem Docker/PostgreSQL/LocalStack.
O smoke Docker também reconstrói a imagem e envia SIGTERM real sob lock SQL,
com drenagem e prazo excedido/redelivery. Resultados exatos, PIDs e limites
estão no relatório; mocks isolados não sustentam as garantias distribuídas.

Referências primárias: [FIFO e batches](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html),
[visibilidade](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html),
[SDK v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sqs_code_examples.html).
