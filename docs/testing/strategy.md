# Estratégia de testes

A [matriz](../requirements.md) liga obrigações do desafio aos testes; os
[cenários distribuídos](distributed-scenarios.md) especificam processos, barreiras
e resultados. A suíte fica em test/, conforme [instruções locais](../../test/AGENTS.md).

## Executar

```sh
bun run format:check
bun run typecheck
bun run lint
bun run test
bun run build
```

Lint inclui dependency-cruiser; não é necessário repetir architecture depois de
lint aprovado. Bun é runtime, package manager e test runner. A suíte normal não
ignora integração quando Docker está indisponível: falha no setup, em vez de
anunciar uma garantia não verificada. Primeira execução pode baixar imagens.

| Escopo                                    | Comando focalizado                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro/Wallet/ledger sem infraestrutura | `bun test test/money.test.ts test/wallet.test.ts test/wallet-ledger-entry.test.ts`                                                     |
| Regras e idempotência de aplicação        | `bun test test/wager-transaction.test.ts test/process-wager.test.ts`                                                                   |
| Schema e terminais SQL                    | `bun test test/persistence.test.ts test/wager-history.test.ts`                                                                         |
| Integração financeira                     | `bun test test/financial-persistence.test.ts test/process-wager-persistence.test.ts`                                                   |
| HTTP e snapshot/concorrência              | `bun test test/http-api.test.ts test/http-concurrency.test.ts`                                                                         |
| Inbox/SQS e recuperação                   | `bun test test/inbox.test.ts test/sqs.test.ts test/sqs-consumer.test.ts`                                                               |
| Publisher/claims/pipeline                 | `bun test test/publisher.test.ts test/publisher-persistence.test.ts test/publisher-pipeline.test.ts test/publisher-recovery.test.ts`   |
| Referências/TTL/fencing                   | `bun test test/pending-worker.test.ts test/pending-persistence.test.ts test/pending-distributed.test.ts test/pending-pipeline.test.ts` |
| Docker e sinais reais                     | `bun test test/consumer-docker.test.ts test/publisher-docker.test.ts test/pending-docker.test.ts`                                      |
| Observabilidade e documentos              | `bun test test/observability.test.ts test/documentation.test.ts`                                                                       |
| Ferramenta de carga e observador SQL      | `bun test test/load-tool.test.ts test/load-observer.test.ts`                                                                           |

Todos integram bun run test. O teste de exemplos executa o trecho curl em Bash
(Git Bash instalado pelo Git no Windows) e comandos awslocal no LocalStack,
substituindo somente endereços/identidades/arquivo temporário do ambiente descartável.
O build Docker faz parte das suítes Docker. O benchmark opcional
`bun run test:load` reutiliza a demo já iniciada e tem
[metodologia e resultados próprios](load-test.md). Ele não integra `bun run test`
nem os jobs obrigatórios do CI. Os testes da ferramenta integram a suíte normal.

Para RE-03, `bun test test/re03-conformance.test.ts test/wagering-persistence.test.ts`
exercita compensação ativa, neutralização, duplicidade por modalidade, precisão e
proteções SQL. Os testes de pendências, falhas e pipeline da tabela também cobrem
a cadeia após neutralização. A [Task 12.1](../history/reports/task12-1-re03-conformance-report.md)
separa interpretação aprovada, casos anteriores e evidência final.

## Infraestrutura e isolamento

[PostgreSQL](../../test/support/postgres.ts) e [LocalStack](../../test/support/sqs.ts)
são reais em projetos Compose próprios, nomes/credenciais efêmeros, portas
dinâmicas e volumes descartáveis. Teardown é obrigatório mesmo em falha. A suíte
não aplica migrations no banco configurado pelo desenvolvedor. Os filhos são
processos Bun com pools/SDKs próprios; promises no mesmo processo não substituem
a prova de múltiplas instâncias.

Barreiras stdin bufferizadas, sinais JSON e pg_stat_activity confirmam aquisição/
espera antes de liberar concorrentes ou matar um processo. Polling tem prazo;
sleep não serve como evidência de corrida. Logs de diagnóstico são separados dos
sinais do harness. Cada fluxo financeiro verifica materializado versus ledger,
contagens, versões e ausência de efeitos parciais.

Migrations são exercitadas por CLI up/status/down/up e violações SQL diretas.
Outbox/Inbox são verificadas junto com os efeitos de negócio, incluindo falha
posterior ao primeiro INSERT. Smoke de imagem verifica JavaScript compilado,
comandos independentes e SIGTERM/deadline reais.

## Verificações estáticas e documentos

[tsconfig](../../tsconfig.json) inclui aplicação, testes e build.ts em strict,
com propriedades opcionais exatas, índices possivelmente ausentes, overrides e
código não usado. Build usa tsc por Bun para metadata Nest. ESLint é type-aware;
supressões inline são proibidas. Prettier mantém tabs/largura 4.

[Testes negativos](../../test/architecture.test.ts) exigem código de saída e nome
da regra violada. Cobrem fronteiras, ciclos, composição em bootstrap e proibição
de mutações financeiras nos adapters técnicos. Regras estáticas não provam toda
a semântica dos métodos; revisão humana continua necessária.

[documentation.test.ts](../../test/documentation.test.ts) verifica links/âncoras
locais, frontmatter das skills, comandos Bun/testes existentes, entrypoints,
rotas HTTP, JSON e configurações de exemplo. Exemplos SQS/eventos passam pelos
parsers de runtime. Diagramas de texto são conferidos contra os fluxos e revisados
separadamente; não exigem dependência de renderização.

## Demonstração e CI

O [workflow](../../.github/workflows/ci.yml) divide a validação em três jobs.
Quality executa formatação, typecheck, lint e build. Integration roda a suíte
completa com os harnesses reais. Docker-smoke sobe o
[Compose independente](../../compose.demo.yaml), executa dois smokes e compara
os IDs dos nove containers para detectar recriações. Depois repete o startup,
reinicia os processos e roda o smoke novamente.

O job Docker também verifica atendimento por duas APIs e recriação da terceira
com outro IP, mantendo o mesmo Nginx. Com o proxy parado, o smoke precisa falhar.
Com todas as APIs paradas, readiness deve retornar 503 e liveness, 200. O job
roda o smoke completo após recriar a API e após recuperar o conjunto de APIs.

O job de integração tem 30 minutos para setup, downloads e testes, mantendo os
timeouts internos da suíte. O workflow guarda logs como artifacts e remove os
recursos descartáveis em always. Confira o resultado remoto na execução do commit
correspondente.

O [smoke](../../docker/smoke.ts) usa HTTP/SQS e SQL somente leitura para conferir
os registros persistidos. Verifica a disputa 100/80/80 em backends distintos e
50 replays concorrentes com o saldo histórico. Também confere conflito de payload,
duplicata entregue pela Inbox, dez eventos publicados a partir da Outbox e
resolução de REFUND fora de ordem. Todo HTTP passa pelo Nginx. Os endereços
resolvidos por DNS e o header `X-Demo-Upstream` identificam as três APIs nas respostas.
As suítes distribuídas cobrem crash entre commit e ACK e fencing. O
[quickstart](../quickstart.md) traz os comandos e explica o isolamento das
identidades e o consumo dos eventos do próprio cenário.

## Alcance da evidência

Mocks unitários cobrem decisões isoladas; só containers/processos reais sustentam
as afirmações de concorrência, atomicidade e recuperação. A suíte não cobre AWS
IAM gerenciada, perda física de disco, backup/failover,
consumer downstream ou agregação durável de métricas. Não há meta de RPS.
Contagens e tempos são resultados datados no [relatório](../history/reports/task12-audit-report.md),
sem transformar números de uma etapa anterior em cobertura atual. O
[benchmark local](load-test.md) tem amostras datadas e limitações próprias;
não estabelece uma meta de RPS.
