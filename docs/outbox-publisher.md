# Operação do Outbox Publisher

Implementação da Task 10, branch `feat/outbox-publisher`, a partir da Task 09
(`2f2c19608995bb4873baa69f6f4526a62cf06a51`). Contrato principal:
[Messaging](domain/messaging.md#task-10--publicação-recuperável). Decisões:
[arquitetura](../ARCHITECTURE.md#task-10--publisher-independente).
[Relatório e evidências](task10-outbox-report.md).

## Executar localmente

Copie [.env.example](../.env.example) para `.env`, conforme o [README](../README.md).
Use credenciais `test` somente no emulador. As dependências continuam sendo as do
lockfile, sem novas bibliotecas nesta tarefa.

```sh
docker compose --project-name dwp --profile sqs up -d --wait
bun run db:migrate
bun run sqs:provision
bun run publisher
# Alternativa compilada:
bun run build
bun run publisher:start
```

O provisionamento explícito agora cria também `wager-events.fifo`, distinta de
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

## Mensagem e ordenação

Body é o envelope JSONB histórico completo, com chaves ordenadas recursivamente.
O contrato usa **`version` e `data`**, conforme o enunciado e a Task 07. Não são
renomeados para eventVersion/payload no JSON público. As colunas técnicas
event_version e payload continuam correspondendo à versão/envelope completo.

São aceitos os quatro eventos v1 já existentes. A validação reutiliza suas
factories, compara o envelope validado integralmente com o persistido e verifica
metadados contra as colunas. O envio serializa o original; nunca consulta Wallet,
recalcula saldo, regenera timestamp ou identidade. Campos desconhecidos ou versão
incompatível permanecem auditáveis como INVALID_EVENT.

`MessageDeduplicationId = eventId`. `MessageGroupId = data.walletId` nos quatro
contratos. aggregateId dos eventos Wagering é transactionId, portanto não serve
como grupo da wallet. FIFO preserva ordem de chegada por grupo; seleção SQL e
envios paralelos **não prometem ordem de commit financeiro**, nem ordem entre
eventos irmãos. O desafio exige integridade financeira por wallet no PostgreSQL;
não exige essa ordem de saída. Não há sequência global ou bloqueio de wallet
durante publicação. Consumidores downstream devem deduplicar por eventId e
considerar walletVersion quando presente. A janela de deduplicação FIFO é de
cinco minutos; duplicatas posteriores continuam possíveis.

## Claims, estados e retry

PENDING confirmado é intenção durável. Claim é adquirido em transação curta:
seleção indexável por next_attempt_at/created_at/id, `FOR UPDATE SKIP LOCKED`,
UPDATE do token UUID, owner, expiração e attempts. Commit libera todos os locks
antes de SendMessage. O índice parcial existente é reutilizado; não se consulta
todo o backlog a cada ciclo. Cada processo envia até batchSize simultaneamente.

`attempts` conta **claims adquiridos e confirmados**, inclusive crash antes do
envio e readquisição após lease. Consultas/diagnósticos não o incrementam.
Não equivale ao número de aceitações SQS nem ao receive count downstream.

O relógio PostgreSQL decide vencimento. Sem renovação: prazo de envio é limitado,
e leases órfãos sempre expiram. Atraso além do lease pode causar envio duplicado;
fencing impede o dono antigo de concluir/agendar/liberar a tentativa nova.
Updates exigem eventId + token + PENDING + lease ainda válido. Zero linhas provoca
consulta de diagnóstico: ALREADY_PUBLISHED, CLAIM_LOST, LEASE_EXPIRED ou MISSING;
não é tratado como conclusão persistida pelo processo antigo.

Somente confirmação SQS com MessageId/SequenceNumber permite o UPDATE atômico
para PUBLISHED, com published_at do banco e limpeza do claim. Envelope e histórico
permanecem. Repetir a finalização não gera efeitos. O schema protege fatos
históricos e impede alteração de uma linha já PUBLISHED.

Falha de envio persiste código sanitizado e next_attempt_at, limpando apenas o
claim atual. Para tentativa n: teto = min(max, min × 2^(n−1)), com expoente
computacional limitado a 32; atraso com jitter uniforme entre min e teto.
Erros permanentes aguardam max. Tentativas são ilimitadas, sem descarte, estado
terminal novo ou reinício manual de contador. Corrigida a causa, o registro volta
a ser tentado. SQL indisponível ao agendar/concluir deixa o lease recuperável;
falha de confirmação SQL após aceite SQS não é reclassificada como falha de envio.

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
não métricas agregadas. API readiness/liveness continuam independentes da saída.

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
bun test test/publisher-sqs.test.ts
bun test test/publisher-docker.test.ts
```

As suítes usam projetos/portas exclusivos e teardown. PostgreSQL real cobre
migrations, integridade, due indexado, SKIP LOCKED e fencing. LocalStack real
cobre HTTP/SQS → Outbox → saída, três pools/processos, identidade, falhas SQL/SQS,
crashes antes/depois do envio, proxy retendo resposta real e readquisição.
Docker cobre imagem compilada e SIGTERM real, drenagem e prazo excedido.
Resultados executados, incluindo limitações, pertencem ao relatório da tarefa.

Não há consumidor downstream, teste contra IAM/AWS gerenciada, teste de carga ou
garantia de retenção infinita no broker. A próxima tarefa é o Pending Reference
Worker, separado do publisher; observabilidade agregada continua pendente.
