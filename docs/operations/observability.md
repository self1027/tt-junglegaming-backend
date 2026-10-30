# Logs, métricas e diagnóstico

A instrumentação técnica em [diagnostic.ts](../../src/platform/observability/diagnostic.ts)
emite JSON com event, pid, campos de correlação disponíveis e um array metrics.
Não há servidor de métricas, exporter, OpenTelemetry ou dashboard. Um coletor
externo pode somar deltas e agregar observações; sua instalação não faz parte da
aplicação entregue.

## Correlação e conteúdo

| Fluxo                    | Identificadores e momento                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP Wagering            | providerId, walletId, transactionId e correlationId=transactionId após commit; replay preserva identidade                                               |
| SQS                      | messageId do envelope, sqsMessageId nativo, receiveCount e IDs do resultado; duplicata Inbox usa messageId como correlação quando não há novo resultado |
| Publisher                | eventId/eventType, correlationId, tentativa, instanceId e IDs disponíveis no data do envelope                                                           |
| Referências              | transactionId/correlationId, walletId, providerId, attempts, outcome e latência                                                                         |
| Reconciliação            | walletId, evento de divergência e contador local                                                                                                        |
| Falha HTTP sem resultado | Categoria/código sanitizado e correlationId próprio; não presume transactionId confirmado                                                               |

Money, saldo, playerId, payload completo, key/hash, ReceiptHandle, credenciais,
SQL e mensagens/stacks de exceções não são registrados nos diagnósticos desses
fluxos. Um campo que não existe naquele fluxo não é inventado: HTTP não tem
messageId de SQS; duplicata Inbox não precisa reler transação para produzir um ID.
Falhas HTTP não copiam identidades do corpo da requisição, que pode ter sido
rejeitado pela validação. O filtro gera sua própria correlationId de diagnóstico.

Completions do HTTP são observadas por interceptor associado ao handler, inclusive
URLs aceitas com barra final/caixa diferente. O consumer emite committed depois da
Promise transacional e antes de ACK; acked só depois de DeleteMessage. Falha de
ACK é separada de falha de processamento. Logs operacionais de startup/loop/sinais
também são JSON, sem representar todos uma amostra financeira.

## Métricas emitidas

Cada amostra tem name, kind, value e labels. Counter é delta (normalmente 1),
gauge é uma medição instantânea e observation é uma duração em ms. IDs não viram
labels; source/status têm vocabulário limitado.

| Nome                             | Tipo e significado                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wagering_results_total           | Counter por source/status de resultado novo aceito em HTTP/SQS; worker conta transição terminal. Replay/duplicata não conta novo resultado. Uma operação pendente e sua resolução são dois resultados, não duas movimentações |
| duplicates_total                 | Counter de replay de negócio HTTP/SQS ou duplicata Inbox                                                                                                                                                                      |
| retries_total                    | Counter de tentativa de reagendar visibilidade SQS (exceto devolução imediata no shutdown), falha de publicação ou espera/retry SQL do worker; não é número de envios aceitos                                                 |
| dlq_visible_messages             | Gauge aproximado de mensagens visíveis na DLQ por GetQueueAttributes; não inclui in-flight nem histórico já removido                                                                                                          |
| lock_conflicts_total             | Counter de erros 55P03/40P01/40001 propagados pela UnitOfWork; não mede toda espera de lock que terminou com sucesso                                                                                                          |
| outbox_lag_ms                    | Gauge da idade do PENDING mais antigo, limitado inferiormente a zero; SQL indisponível não produz zero artificial                                                                                                             |
| processing_duration_ms           | Observation do HTTP (inclui falhas), consumer confirmado e tentativa de resolução; inclui espera SQL. Não é duração ponta a ponta desde envio do produtor                                                                     |
| reconciliation_divergences_total | Counter de diagnóstico de reconciliação inconsistente                                                                                                                                                                         |

Publisher faz diagnóstico de dependências/lag com intervalo mínimo de 30s entre
ciclos. Consumer checa filas/DLQ no startup e no polling após o intervalo mínimo de
30s; long poll, backoff ou trabalho em andamento podem adiar a próxima medição.
Readiness da API também usa check SQS sem consumir. Check falho não publica gauge
saudável inventado.

## Limites e uso operacional

Logs/amostras são best effort. Crash depois do commit e antes de registrar pode
perder a medição; coleta duplicada pode duplicar delta. Contadores locais reiniciam
com o processo. Não usar essas amostras como fonte financeira ou contagem exata
de operações únicas: consulte PostgreSQL/ledger/idempotência para auditoria.
A falha do sink de diagnóstico não transforma um commit confirmado em resposta de
erro financeiro. Não há armazenamento ou agregação distribuída de métricas.

Readiness saudável não atesta consumo/publicação/drenagem de backlog. Observe lag,
DLQ e sinais dos processos e use [recuperação](failure-recovery.md) para decidir
próximos passos, preservando identidades e histórico.

[Testes de métricas](../../test/observability.test.ts),
[HTTP com logs reais](../../test/http-api.test.ts),
[conflito SQL real](../../test/financial-persistence.test.ts) e
[SQS real](../../test/sqs.test.ts) verificam emissão/segurança e sinais de origem.
