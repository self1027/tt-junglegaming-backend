# Desenvolvimento local e configuração

Requer Bun 1.4.4 no PATH e Docker com Compose e containers Linux. Node, npm, Yarn,
pnpm e Nest CLI não são necessários para os comandos da aplicação. Dependências
diretas têm versão exata; instale por `bun install --frozen-lockfile`.

## Provisionar e iniciar

Na primeira execução, copie [.env.example](../../.env.example) para `.env` sem
sobrescrever configuração existente. O [README](../../README.md#executar) traz os
comandos PowerShell. Em Bash, use `cp .env.example .env` somente se ainda não existe.
Bun e Compose carregam `.env`; variáveis explícitas do processo podem sobrescrevê-las.

```sh
docker compose --project-name dwp --profile sqs up -d --wait
bun run db:migrate
bun run db:status
bun run sqs:provision
```

PostgreSQL mantém volume; LocalStack não tem volume persistente. O perfil sqs
adiciona o emulador. Aplicação/CLI usam PostgreSQL existente, sem criar banco,
sincronizar schema ou aplicar migrations no startup. O provisionamento SQS é
exclusivo do ambiente local e exige endpoint customizado; não executar na AWS.

Inicie em quatro terminais:

| Processo    | Fonte                    | Após build                     |
| ----------- | ------------------------ | ------------------------------ |
| API         | `bun run dev`            | `bun run start`                |
| Consumer    | `bun run consumer`       | `bun run consumer:start`       |
| Publisher   | `bun run publisher`      | `bun run publisher:start`      |
| Referências | `bun run pending:worker` | `bun run pending:worker:start` |

`bun run build` limpa dist e usa tsc executado por Bun, preservando metadata de
injectors/decorators Nest. Emissão inclui os quatro entrypoints. Cada processo
abre recursos próprios. Consumer/publisher validam SQL/SQS no startup; worker
precisa somente SQL. API escuta em 0.0.0.0 e exige PostgreSQL no startup; falta de
SQS permite iniciar, mas readiness fica 503. [Contratos HTTP](../contracts/http.md).

## Ambiente

| Variável                                      | Regra                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| PORT                                          | API: padrão 3000, inteiro de 1 a 65535                                        |
| POSTGRES_HOST, POSTGRES_PORT                  | Obrigatórios na aplicação/CLI; porta de 1 a 65535                             |
| POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD | Obrigatórios e não vazios                                                     |
| POSTGRES_POOL_MAX                             | Padrão 10 por processo, inteiro positivo compatível com INTEGER               |
| AWS_REGION e credenciais/endpoint/URLs SQS    | [Consumer](consumer.md#configuração) e [publisher](publisher.md#configuração) |
| PUBLISHER_*                                   | [Orçamentos e concorrência](publisher.md#configuração)                        |
| PENDING_*                                     | [TTL, SQL, leases e shutdown](pending-worker.md#configuração)                 |

Compose publica PostgreSQL e LocalStack em loopback; a porta SQS padrão é 4566.
As credenciais test da amostra são do emulador. Na AWS, o SDK admite cadeia padrão
com roles; permissões de broker são responsabilidade do ambiente.

Trocar credenciais no `.env` não modifica um volume PostgreSQL já inicializado.
Alinhe-as ao banco existente. Pool tem min 0, timeout de conexão 5s e idle 30s;
consumer/publisher/worker acrescentam limites SQL conforme seus runbooks.
Readiness saudável não mede backlog, locks ou prontidão de todos os workers.

## Exercitar os contratos

1. Use os [exemplos curl HTTP](../contracts/http.md#exemplos-curl-reproduzíveis) em
   Bash: criam wallet, enviam BET/replay, consultam wallet/ledger/transação e reconciliam.
2. Use a wallet criada no [envio SQS](consumer.md#exemplo-de-envio-reproduzível),
   com outra identidade externa/key/messageId para uma operação nova.
3. Observe `committed`/`acked` no consumer e os eventos na saída com o comando do
   runbook. Publisher precisa estar ativo. Pendências precisam também do worker.

Os JSON de exemplo não criam as identidades referenciadas automaticamente. Nunca
reutilize uma key para representar outro comando. Consulte reconciliação depois
dos efeitos e dos testes de recuperação; ela sinaliza divergência sem corrigir.

## Docker

Migrations são executadas pelo checkout com dependências completas. A imagem de
produção contém dependências de runtime, usuário bun e entrypoint compilado; não
contém a CLI de migrations. Bun está fixado por versão/digest no Dockerfile.
Ao atualizá-lo, alterar packageManager, engines e imagem juntos.

```sh
docker build -t distributed-wagering-processor .
docker run --rm --name dwp-api --network dwp_default --env-file .env -p 3000:3000 \
  -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 \
  -e SQS_ENDPOINT=http://localstack:4566 \
  -e SQS_QUEUE_URL=http://localstack:4566/000000000000/wager-transactions.fifo \
  -e SQS_DLQ_URL=http://localstack:4566/000000000000/wager-transactions-dlq.fifo \
  distributed-wagering-processor
```

Em outro terminal, `curl http://localhost:3000/health/live` confirma liveness.
URLs internas usam localstack:4566; 127.0.0.1 dentro da imagem aponta ao próprio
container. Exemplos dos outros três processos ficam nos seus runbooks.

## Parar e recuperar

Ctrl+C no checkout ou SIGTERM no container interrompe novas aquisições e permite
drenagem conforme o processo. O timeout externo do orquestrador deve exceder o
shutdown configurado. Prazo excedido não confirma trabalho incompleto; recuperação
ocorre por redelivery/lease. [Falhas e sinais](failure-recovery.md).

```sh
docker compose --project-name dwp --profile sqs down
```

Down preserva volume PostgreSQL; não use --volumes no banco do desenvolvedor.
Recriar LocalStack apaga filas e mensagens; provisione novamente. PUBLISHED não é
republicado automaticamente. `bun run db:rollback` reverte a última migration;
a reversão da fundação recusa ledger confirmado. Não usar down como remediação
financeira; prefira migration corretiva forward com backup.

[Verificações](../testing/strategy.md) usam ambientes descartáveis próprios, portas
dinâmicas e teardown. Imagens podem ser baixadas na primeira execução.
