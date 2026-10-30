# Operação do Pending Reference Worker

O processo SQL resolve operações existentes, separado do publisher e do consumer.
[Regras, TTL e replay](../domain/wagering.md#resolução-de-referências),
[ordem de locks](../architecture/concurrency.md) e
[claims SQL](../persistence.md#claims-e-fencing) descrevem as garantias.

## Iniciar

Use PostgreSQL e credenciais conforme o [README](../../README.md) e
[.env.example](../../.env.example). Aplique migrations explicitamente:

```sh
docker compose --project-name dwp up -d --wait
bun run db:migrate
bun run pending:worker
# Alternativa compilada:
bun run build
bun run pending:worker:start
```

O contexto Nest abre pool próprio, sem listener HTTP e sem cliente SQS.
Nenhuma fila, notificação ou publisher é necessário para descobrir referências.
O polling SQL garante novas tentativas quando a referência aparece. A publicação
dos fatos confirmados continua pela [Outbox existente](publisher.md).

## Configuração

| Variável               | Default / regra                                                  |
| ---------------------- | ---------------------------------------------------------------- |
| PENDING_INSTANCE_ID    | UUID por processo; 1–128 caracteres alfanuméricos ou `._:-`      |
| PENDING_POLL_MS        | 1000; intervalo entre lotes, inclusive quando há backlog         |
| PENDING_CONCURRENCY    | 4; máximo 100                                                    |
| PENDING_BATCH_SIZE     | 4; no máximo concurrency; todos os claims do lote começam juntos |
| PENDING_SQL_MS         | 5000; statement timeout e aquisição do pool                      |
| PENDING_LEASE_MS       | 30000; mínimo 2 × SQL + 2000ms                                   |
| PENDING_SHUTDOWN_MS    | 30000; mínimo 2 × SQL + 2000ms                                   |
| PENDING_BACKOFF_MIN_MS | 1000                                                             |
| PENDING_BACKOFF_MAX_MS | 300000; mínimo não pode superar máximo                           |
| PENDING_TTL_MS         | 86400000 (24h); máximo 2592000000 (30 dias)                      |

Durações são inteiros positivos até 3600000ms, exceto TTL. Os limites de
configuração são operacionais, sem teto monetário. PostgreSQL usa também
transaction_timeout = SQL + 1000ms: permite rollback após um statement cancelado
e limita a soma da execução. O limite total ainda pode encerrar uma conexão;
claims e transações continuam recuperáveis. Lease/shutdown cobrem aquisição,
transação e margem. Configuração inválida ou SQL indisponível no startup sai 1.

## Tentativas e espera

Attempts conta claims confirmados, inclusive crash antes de resolver; não equivale
ao número de consultas, replays ou recebimentos SQS. Lease não é renovado; outro
processo readquire com token novo após expiração. O UPDATE final confere token,
estado esperado e lease válido, revertendo toda a UnitOfWork se falhar.

O worker agenda nova tentativa com backoff, sem manter locks durante a espera.
TTL nasce de created_at e é avaliado em tentativa elegível; indisponibilidade ou
backlog podem adiar a avaliação. Referência já elegível continua processável após
TTL. A matriz e os códigos pertencem a [Wagering](../domain/wagering.md#resolução-de-referências).

## Falhas, replay e recuperação

| Ponto da falha                      | Recuperação                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Antes do claim confirmar            | Nada adquirido; outro processo seleciona                                                     |
| Após claim, antes/durante resolução | Lease expira; UnitOfWork incompleta reverte                                                  |
| Erro SQL/deadlock/timeout           | Rollback financeiro; retry técnico com SQL_UNCERTAIN e backoff, condicionado ao claim válido |
| Erro ao agendar retry               | RETRY_UNCERTAIN no log; lease continua recuperável                                           |
| Claim perdido/expirado              | Nenhum efeito confirmado; dono atual ou próximo lease resolve                                |
| Após commit terminal, antes do log  | Terminal deixa de ser selecionado; replay retorna snapshot terminal                          |

Retry técnico ocorre somente depois de a UnitOfWork retornar com rollback/erro.
Um commit cuja confirmação se perdeu não será reaberto: UPDATE técnico aceita
apenas não terminais e token válido. Eventos confirmados ficam na Outbox para o
publisher. Nunca editar payloads históricos para representar a resolução.

Logs JSON incluem instanceId/PID, transactionId, walletId, providerId, attempts
e outcome, sem dinheiro, payload completo, credenciais ou texto de exceções.
SQL_UNCERTAIN também representa falha inesperada que exige investigação;
não classifica automaticamente infraestrutura como permanente. Há amostras JSON
de resultado/latência/retry, sem backend agregado ou listener de readiness próprio.
[Observabilidade](observability.md).

Consultas somente leitura:

```sql
select id, status, attempts, last_attempt_at, next_attempt_at, last_error,
       claimed_by, claimed_until, failure_code
from wager_transactions
where status in ('PENDING', 'PENDING_REFERENCE')
  and reference_external_transaction_id is not null
order by coalesce(next_attempt_at, created_at), created_at, id
limit 100;
```

Para falha técnica, restaurar PostgreSQL/configuração e aguardar retry/lease.
Para referência inexistente, investigar a entrega original antes do TTL.
Rejeição terminal não é reaberta; ajuste de saldo/manual replay HTTP estão fora
do escopo. Reconciliação verifica a integridade e nunca corrige silenciosamente.

## Shutdown e Docker

SIGTERM/SIGINT param novas aquisições/iterações e acordam a espera do polling.
Se o sinal chegar durante aquisição, os claims retornados não começam resolução;
expiram. Operações iniciadas drenam dentro do prazo; depois o contexto/pool fecha
e sai 0. Prazo excedido sai 1 e o encerramento do processo desconecta sessões;
claim e trabalho não confirmado continuam recuperáveis. SIGKILL não usa hooks.

```sh
docker build -t distributed-wagering-processor .
docker run --rm --name dwp-pending --network dwp_default --env-file .env \
  -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 \
  distributed-wagering-processor bun dist/main.pending-worker.js
docker kill --signal=SIGTERM dwp-pending
```

Nenhuma migration no startup. Para rollback da migration, parar workers antes:
down preserva histórico e scheduling, mas remove claims técnicos e índice novo.
Prefira correção forward em produção; não remover ledger.

## Verificação reproduzível

```sh
bun test test/pending-worker.test.ts
bun test test/pending-persistence.test.ts
bun test test/pending-distributed.test.ts
bun test test/pending-pipeline.test.ts
bun test test/pending-docker.test.ts
```

Unidade sem PostgreSQL; persistência real com migration/EXPLAIN/constraints,
rollback em cada participante, precisão e TTL; processos Bun com pools próprios,
barreiras stdin e pg_stat_activity; HTTP/SQS → resolução → publisher → FIFO;
imagem compilada, SIGTERM normal, timeout SQL e deadline durante PostgreSQL
pausado. As contagens e reconciliações executadas estão no relatório.
Sem AWS gerenciada/IAM, carga ou promessa de exactly-once delivery.
