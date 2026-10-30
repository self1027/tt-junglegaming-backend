# Referência técnica

Comece pelo [README](../README.md) e pelo [quickstart](quickstart.md) para executar o serviço e pela
[arquitetura](../ARCHITECTURE.md) para identificar módulos e processos.

| Assunto                                             | Fonte responsável                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Obrigações, conformidade e divergências             | [Enunciado imutável](challenge.md) e [matriz de requisitos](requirements.md)                                     |
| Processos e limites de commit                       | [Fluxos](architecture/data-flow.md)                                                                              |
| Locks, concorrência e recuperação por claim         | [Concorrência](architecture/concurrency.md)                                                                      |
| Money, Wallet, ledger e snapshot de reconciliação   | [Financial](domain/financial.md)                                                                                 |
| Operações, referências, reversões, estados e replay | [Wagering](domain/wagering.md)                                                                                   |
| Inbox, ACK e semântica de publicação                | [Messaging](domain/messaging.md)                                                                                 |
| HTTP e respostas                                    | [Contrato HTTP](contracts/http.md)                                                                               |
| Envio de comandos SQS                               | [Envelope SQS](contracts/sqs-commands.md)                                                                        |
| Eventos, payloads e compatibilidade                 | [Eventos de integração](contracts/integration-events.md)                                                         |
| Schema, migrations, índices e adapters              | [Persistência](persistence.md)                                                                                   |
| Setup, ambiente, build e Docker                     | [Desenvolvimento local](operations/local-development.md)                                                         |
| Operação dos processos assíncronos                  | [Consumer](operations/consumer.md), [publisher](operations/publisher.md), [worker](operations/pending-worker.md) |
| Falhas, leases expirados e shutdown                 | [Recuperação](operations/failure-recovery.md)                                                                    |
| Logs, métricas e diagnóstico                        | [Observabilidade](operations/observability.md)                                                                   |
| Seleção de testes e evidência distribuída           | [Estratégia](testing/strategy.md) e [cenários](testing/distributed-scenarios.md)                                 |
| Planos e resultados anteriores                      | [Histórico](history/README.md)                                                                                   |
| Navegação assistida do código                       | [Graphify](tooling/graphify.md) e [Ponytail](tooling/ponytail.md)                                                |

Regras de negócio pertencem aos domínios; contratos externos descrevem o protocolo;
runbooks dizem como executar e recuperar. Alterações de schema começam nas
migrations; alterações do desafio são divergências registradas na matriz.
