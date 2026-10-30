# Falhas e recuperação

Antes de reenviar, consulte transação, Inbox/idempotência e reconciliação. Uma
resposta perdida, ACK incerto ou lease expirado não prova que a operação falhou.
Preserve identidades de negócio/envelope nos retries; não altere saldo ou ledger
para ocultar divergência.

## Encontrar o estado durável

Use consultas HTTP por ID interno ou provider/ID externo, ledger e reconciliação
conforme o [contrato](../contracts/http.md). Para trabalho técnico, use SQL somente
leitura dos runbooks de [publisher](publisher.md#diagnóstico-e-recuperação-operacional)
e [referências](pending-worker.md#falhas-replay-e-recuperação).
Correlacione transactionId/eventId/messageId nos [logs](observability.md).

| Sinal/ponto de falha                      | Estado esperado e ação                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Processo morre antes do commit financeiro | Transação reverte; retry com identidade original pode aplicar uma vez                                    |
| Commit confirmado, resposta HTTP perdida  | Reenviar mesma key/payload; replay conserva resultado histórico                                          |
| Commit confirmado, ACK ausente/falho      | SQS redelivera; Inbox impede novos efeitos; não criar operação substituta                                |
| Consumer não confirma SQL                 | Sem ACK; backoff/visibilidade e redrive limitam entrega; restaurar dependência                           |
| Mensagem chega à DLQ                      | Registrar diagnóstico e verificar corpo/identidades/resultado antes de redrive                           |
| Outbox PENDING sem publisher              | Iniciar/restaurar publisher; intenção permanece durável no PostgreSQL                                    |
| Claim Outbox expirado                     | Outro publisher readquire com token novo; consultar last_error e fila de saída                           |
| SQS aceitou, SQL não marcou PUBLISHED     | Republicação idêntica possível; consumidor downstream deduplica eventId                                  |
| Referência ainda ausente                  | Conferir entrega da original antes do TTL; worker faz nova avaliação                                     |
| Claim do worker perdido durante resolução | Fencing final reverte efeitos; aguardar dono atual/novo lease                                            |
| Rejeição terminal                         | Não reabrir registro; investigar failureCode e usar procedimento financeiro explícito fora deste serviço |
| Reconciliação inconsistente               | Preservar evidências; diagnosticar origem, sem UPDATE de saldo/ledger silencioso                         |

## PostgreSQL ou SQS indisponível

API requer PostgreSQL no startup; em execução traduz falhas transitórias
reconhecidas para 503 e preserva liveness. Readiness verifica SQL e filas de
comandos/DLQ, sem consumir. Falta da fila de saída ou worker parado não é verificada
pela readiness da API. Consumer e publisher abortam se suas dependências iniciais
falharem; após startup registram falhas e tentam recuperar. Worker usa somente SQL.

Indisponibilidade longa pode levar comandos válidos à DLQ pelo receive count.
Depois de restaurar a causa, redrive é uma ação operacional deliberada, não
automática. Novo corpo exige novo messageId e análise da idempotência de negócio.
Erros permanentes do publisher não descartam Outbox: corrigida configuração,
contrato suportado ou permissão, o evento volta a ser tentado pelo backoff.

Dados confirmados dependem da durabilidade PostgreSQL. Backups/restauração,
failover gerenciado, IAM AWS e perda física de armazenamento não são exercitados
pela suíte local. Retenção do SQS é finita. Recriar o emulador sem volume apaga
mensagens; Outbox PUBLISHED permanece assim e não repõe a fila automaticamente.

## SIGTERM, deadline e SIGKILL

| Processo    | SIGTERM/SIGINT                                                                                | Prazo excedido ou morte abrupta                                                          |
| ----------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| API         | Hooks Nest fecham servidor/pool                                                               | Resposta pode se perder; cliente consulta/reenvia mesma identidade                       |
| Consumer    | Aborta polling, impede novo trabalho e drena; lotes não iniciados podem devolver visibilidade | Saída 1 no deadline; desconexão reverte SQL incompleto, mensagem volta após visibilidade |
| Publisher   | Para claims e drena envios iniciados; sinal durante claim não inicia novos envios             | Saída 1/abort SDK no deadline; lease fica recuperável, aceite anterior pode ser incerto  |
| Referências | Para aquisições, acorda polling e drena resoluções iniciadas                                  | Saída 1 no deadline; transação incompleta reverte e claim expira                         |

SIGKILL não executa hooks. Banco libera locks após detectar desconexão; leases e
visibilidade têm seus próprios prazos. Não se promete drenagem após SIGKILL.
SIGTERM também não promete concluir fora do orçamento configurado. Dimensione o
prazo do Docker/orquestrador acima do shutdown da aplicação. Exemplos de sinais
ficam nos runbooks de cada processo; testes Docker usam sinais reais.

## Verificação

[Cenários distribuídos](../testing/distributed-scenarios.md) ligam cada janela aos
testes reais e às assertivas finais. Publisher recovery retém respostas reais de
SendMessage e simula indisponibilidade SQL/SQS; consumer morre antes/depois de
commit; worker testa fencing final e reinício. Os resultados de uma execução não
provam resistência a falhas de infraestrutura que não foram produzidas no teste.
