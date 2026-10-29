# Operação do Pending Reference Worker

Task 11 na branch `feat/pending-reference-worker`, a partir da Task 10 no commit
`704dea0fedd26af067f086f281dc29b2f9c3cb3b`. [Contrato principal e matriz de resolução](domain/wagering.md#task-11--resolução-de-referências),
[arquitetura](../ARCHITECTURE.md#task-11--worker-de-referências) e
[relatório](task11-pending-report.md). Worker e publisher são processos distintos.

## Iniciar

Use PostgreSQL e credenciais conforme o [README](../README.md) e
[.env.example](../.env.example). Aplique migrations explicitamente:

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
dos fatos confirmados continua pela [Outbox existente](outbox-publisher.md).

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

## Aquisição, tentativas e espera

A migration incremental acrescenta claim_token, claimed_by e claimed_until à
própria WagerTransaction. O trio deve ser nulo ou completo, com lease finito e
estado não terminal. Índice parcial cobre ambos os estados de referência por
`coalesce(next_attempt_at,created_at), created_at, id`; NULL legado é elegível
desde a criação. A seleção usa limite, range indexável por statement_timestamp()
e FOR UPDATE SKIP LOCKED. A aquisição confirma antes de esperar a wallet.

attempts incrementa por **claim confirmado**, inclusive crash antes de resolver;
last_attempt_at registra a aquisição no relógio SQL. Não conta queries ou replays.
Não equivale a tentativas de entrega SQS. O lease não é renovado. Outro processo
pode readquirir após vencimento com token novo, inclusive com o mesmo instanceId.

O resolver relê sob idempotência/identidade/wallet e valida o token. O UPDATE
final confere novamente token, estado esperado e lease ainda válido. Um worker
antigo não confirma efeitos nem limpa o claim novo. Se expirar durante os efeitos,
toda a UnitOfWork reverte. Não existe mutex global entre wallets.

Para tentativa n, teto = min(max, min × 2^(n−1)), expoente limitado a 32;
atraso inteiro com jitter uniforme entre min e teto. Espera grava NOT_FOUND ou
NOT_PROCESSED, agenda next_attempt_at e limpa o claim. Não mantém locks durante
o backoff. Snapshot e eventos permanecem os originais até uma decisão terminal.

TTL nasce de created_at persistido e não reinicia. É avaliado na próxima tentativa
elegível, sujeito ao scheduling e à disponibilidade do banco. Depois do prazo, a decisão
atual prevalece: referência já elegível ainda é aplicada; ausência/incompletude
produz o código terminal específico da [matriz contratual](domain/wagering.md#task-11--resolução-de-referências).
24 horas acomodam desordem/indisponibilidade curta sem deixar referências órfãs
indefinidamente; é a política local aprovada, configurável conforme operação.
Não há limite adicional de attempts nem conversão de falha técnica em rejeição.

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
não classifica automaticamente infraestrutura como permanente. Métricas agregadas
e readiness específico do worker não foram adicionados.

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
