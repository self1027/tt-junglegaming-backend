# Operação do Outbox Publisher

O publisher envia somente Outbox confirmada para uma fila separada de eventos.
[Semântica de publicação](../domain/messaging.md#publicação-recuperável),
[envelopes e ordenação](../contracts/integration-events.md) e
[claims SQL](../persistence.md#claims-e-fencing) são as fontes contratuais.

## Executar localmente

Copie [.env.example](../../.env.example) para `.env`, conforme o [README](../../README.md).
Use credenciais `test` somente no emulador. Instale as dependências pelo lockfile antes de executar.

```sh
docker compose --project-name dwp --profile sqs up -d --wait
bun run db:migrate
bun run sqs:provision
bun run publisher
# Alternativa compilada:
bun run build
bun run publisher:start
```

O provisionamento explícito cria `wager-events.fifo`, distinta de
`wager-transactions.fifo` e sua DLQ. FIFO, deduplicação explícita e retenção de
14 dias. Não há consumer downstream nem redrive de saída: os registros confirmados
permanecem na Outbox. Não há criação de filas ou migration no startup.

O Compose mantém o padrão de serviços de infraestrutura. API, consumer e publisher
executam como processos separados; nenhum listener HTTP é aberto pelo publisher.
O perfil sqs e seus projetos descartáveis de teste são reutilizados. Não há volume
global de LocalStack. Recriar o emulador apaga suas filas; eventos já PUBLISHED não
são reenviados automaticamente. Isso é uma limitação do ambiente local.

## Configuração

| Variável                   | Default / regra                                                      |
| -------------------------- | -------------------------------------------------------------------- |
| `AWS_REGION`               | Obrigatória, mesma convenção do consumer                             |
| `SQS_ENDPOINT`             | Opcional; emulador local no exemplo                                  |
| `SQS_EVENTS_QUEUE_URL`     | Obrigatória, URL HTTP(S) FIFO sem credenciais/query/fragmento        |
| `PUBLISHER_INSTANCE_ID`    | UUID por processo; texto de 1–128 caracteres alfanuméricos ou `._:-` |
| `PUBLISHER_TIMEOUT_MS`     | 10000; orçamento total de SendMessage; SDK sem retry interno         |
| `PUBLISHER_SQL_MS`         | 5000; timeouts de statement, transação e aquisição do pool           |
| `PUBLISHER_CONCURRENCY`    | 4; máximo 100                                                        |
| `PUBLISHER_BATCH_SIZE`     | 4; entre 1 e concurrency; nenhum claim aguarda vaga de envio         |
| `PUBLISHER_POLL_MS`        | 1000; intervalo quando não há trabalho                               |
| `PUBLISHER_LEASE_MS`       | 30000; mínimo timeout + 2 × SQL + 1000ms                             |
| `PUBLISHER_SHUTDOWN_MS`    | 30000; prazo total de drenagem e fechamento                          |
| `PUBLISHER_BACKOFF_MIN_MS` | 1000                                                                 |
| `PUBLISHER_BACKOFF_MAX_MS` | 300000; máximo também para erro permanente                           |

Todas as durações são inteiros positivos até 3600000ms. Backoff mínimo não pode
exceder o máximo. Configuração PostgreSQL é a mesma do README; pool separado por
processo. Credenciais AWS vêm da cadeia padrão do SDK. Entrada/DLQ não são
dependências do publisher; quando suas URLs estão configuradas, é recusado usar
o mesmo caminho de fila como saída, inclusive com outro hostname local.

## Erros e recuperação

O envio preserva envelope histórico, eventId, version e data. Fencing controla
finalização/retry; aceite SQS seguido de resultado SQL incerto permite duplicata.
Não remova eventos nem reinicie attempts para contornar erro. O protocolo completo
fica em [Messaging](../domain/messaging.md#publicação-recuperável).

| Diagnóstico                        | Recuperação                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| INVALID_EVENT                      | Conferir contrato/versão e origem; adicionar suporte compatível ou migration corretiva explícita, sem editar fatos históricos |
| QUEUE_MISSING                      | Provisionar a fila correta/corrigir configuração e reiniciar se necessário                                                    |
| ACCESS_DENIED                      | Corrigir IAM/cadeia de credenciais                                                                                            |
| INVALID_REQUEST                    | Corrigir configuração/limites do transporte                                                                                   |
| THROTTLED                          | Retry com backoff                                                                                                             |
| SEND_UNCERTAIN                     | Conectividade/timeout/resultado desconhecido: reenviar mesma identidade                                                       |
| FINALIZE_UNCERTAIN / SQL_UNCERTAIN | Restaurar PostgreSQL; aguardar lease expirar e readquirir                                                                     |

Configuração inválida ou dependência indisponível no startup causa saída 1 e
preserva a Outbox. Depois do startup, erros são diagnosticados e o loop tenta
recuperar. Falha de uma mensagem não impede permanentemente eventos distintos.

## Diagnóstico e recuperação operacional

Logs JSON incluem instanceId/PID, eventId, eventType, tentativa, resultado,
latência e código permitido. Não incluem envelope financeiro, credenciais ou
texto/stack de exceções. `claim_recovered` indica lease anterior expirado e
resultado anterior potencialmente incerto. A cada 30 segundos há diagnóstico de
loop ativo, acesso SQL/fila, PENDING, leases expirados e idade do evento pendente
mais antigo. Contadores de sucessos/retries e lastError são locais ao processo,
sem agregação entre processos. As amostras de lag/retry estão descritas em
[observabilidade](observability.md). API readiness/liveness são independentes da saída.

Consultas somente leitura para investigação:

```sql
select event_id, event_type, status, attempts, last_error, next_attempt_at,
       claimed_by, claimed_until, published_at
from outbox_messages
where status = 'PENDING'
order by next_attempt_at, created_at, id
limit 100;

select count(*) as pending, min(created_at) as oldest_pending
from outbox_messages where status = 'PENDING';
```

Se morrer antes do claim, nada muda. Após claim/antes ou durante envio, outro
processo readquire após expiração. Após aceite SQS/antes de PUBLISHED, pode haver
republicação idêntica. Depois de PUBLISHED, o evento deixa de ser elegível.
Não há transação distribuída PostgreSQL/SQS nem exactly-once delivery.

SIGTERM/SIGINT impedem novos claims/iterações e drenam envios iniciados. Se o
sinal chegar durante aquisição, os claims retornados ficam para recuperação pelo
lease, sem iniciar novos envios. No caminho normal, SDK e pool fecham e a saída
é 0. Prazo excedido aborta o SDK e encerra com 1; desconexão do processo libera
sessões SQL e leases continuam recuperáveis. SIGKILL não depende de hooks.

## Docker e testes

```sh
docker build -t distributed-wagering-processor .
docker run --rm --name dwp-publisher --network dwp_default --env-file .env \
  -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 \
  -e SQS_ENDPOINT=http://localstack:4566 \
  -e SQS_EVENTS_QUEUE_URL=http://localstack:4566/000000000000/wager-events.fifo \
  distributed-wagering-processor bun dist/main.publisher.js
docker kill --signal=SIGTERM dwp-publisher
```

Em outro terminal, use API/consumer conforme o README. URLs de entrada/DLQ no
publisher são somente proteção contra configuração incorreta; seus hostnames
não afetam publicação. Não use down --volumes no banco do desenvolvedor.

```sh
bun test test/publisher.test.ts
bun test test/publisher-persistence.test.ts
bun test test/publisher-pipeline.test.ts test/publisher-recovery.test.ts
bun test test/publisher-docker.test.ts
```

As suítes usam projetos/portas exclusivos e teardown. PostgreSQL real cobre
migrations, integridade, due indexado, SKIP LOCKED e fencing. LocalStack real
cobre HTTP/SQS → Outbox → saída, três pools/processos, identidade, falhas SQL/SQS,
crashes antes/depois do envio, proxy retendo resposta real e readquisição.
Docker cobre imagem compilada e SIGTERM real, drenagem e prazo excedido.
Resultados executados, incluindo limitações, pertencem ao relatório da tarefa.

Não há consumidor downstream, teste contra IAM/AWS gerenciada, teste de carga ou
garantia de retenção infinita no broker. O [worker de referências](pending-worker.md) executa separado; métricas não têm backend agregado.
