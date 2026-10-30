# Distributed Wagering Processor

Serviço financeiro que recebe apostas por HTTP ou SQS, mantém saldo e ledger no
PostgreSQL e publica os fatos confirmados por Transactional Outbox. API, consumer,
publisher e worker de referências são quatro processos independentes do mesmo
monólito modular hexagonal. O banco coordena operações concorrentes por wallet;
FIFO ajuda o transporte, sem substituir idempotência e locks SQL.

Stack: Bun **1.4.4**, TypeScript strict, NestJS, MikroORM, PostgreSQL e SQS via
LocalStack. Versões e scripts pertencem ao [package.json](package.json); imagens
e digests estão no [Compose](compose.yaml) e [Dockerfile](Dockerfile).

## Executar

Requer Bun no PATH e Docker Engine/Desktop com Compose e containers Linux.
Na primeira execução, em PowerShell:

```powershell
bun install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose --project-name dwp --profile sqs up -d --wait
bun run db:migrate
bun run sqs:provision
bun run dev
```

Abra outros terminais no checkout, com o mesmo `.env`:

| Processo                           | Comando                  |
| ---------------------------------- | ------------------------ |
| Consumer de comandos SQS           | `bun run consumer`       |
| Publicação de eventos              | `bun run publisher`      |
| Resolução de referências pendentes | `bun run pending:worker` |

`GET http://localhost:3000/health/live` verifica o processo HTTP.
`GET http://localhost:3000/health/ready` verifica PostgreSQL e a configuração/acesso
às filas de comandos e DLQ. Ambos são abertos. Migrations e provisionamento são
explícitos; os processos não os executam no startup.

O [guia local](docs/operations/local-development.md) explica configuração, execução
compilada, Docker e shutdown. Para criar wallet, enviar apostas e consultar ledger
e reconciliação, use os [exemplos HTTP](docs/contracts/http.md#exemplos-curl-reproduzíveis).
O [guia do consumer](docs/operations/consumer.md#exemplo-de-envio-reproduzível)
mostra o envio SQS e a observação dos eventos publicados.

## Verificar

```sh
bun run format:check
bun run typecheck
bun run lint
bun run test
bun run build
```

`lint` inclui arquitetura. A suíte usa PostgreSQL/LocalStack e processos reais,
cria ambientes descartáveis próprios e exige Docker; exemplos executáveis também
usam Bash/curl (Git Bash no Windows). Não usa o banco local do
desenvolvedor. Seleção de testes e limites de cobertura estão na
[estratégia de testes](docs/testing/strategy.md).

## Referências e limites

O [índice técnico](docs/index.md) reúne [arquitetura](ARCHITECTURE.md), contratos,
domínios, persistência e runbooks. A [matriz de requisitos](docs/requirements.md)
liga o enunciado imutável a código, testes e limitações; o
[relatório da Task 12](docs/history/reports/task12-audit-report.md) registra a auditoria.

Autenticação está omitida, com `NoAuthGuard` e desenho de integração com IdP.
Reversões seguem a política de compensação ativa e unicidade por modalidade em
[Wagering](docs/domain/wagering.md#políticas-e-reversões). A entrega de eventos é
at-least-once; consumidores devem deduplicar por `eventId`. Métricas são amostras
JSON, sem backend agregado. Recriar LocalStack apaga suas filas, inclusive eventos
já publicados. Os [procedimentos de recuperação](docs/operations/failure-recovery.md)
explicam essas janelas e seus limites.
