# API HTTP — Task 08

Contratos derivados do [enunciado §9](challenge.md#9-api-http). Regras de negócio e failure codes permanecem em [Financial](domain/financial.md) e [Wagering](domain/wagering.md). HTTP é adapter de entrada: valida, monta comandos explícitos e delega aos casos de uso. Não consulta saldo para processar apostas, não calcula hash, não adquire locks e não abre SQL nos controllers.

## Rotas e resultados

| Método e rota                                                             | Resultado                                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | 201, wallet criada; 409 se player/moeda já existem                                             |
| `GET /wallets/:walletId`                                                  | 200, wallet; 404 ausente                                                                       |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50`                       | 200, `{ items, nextCursor }`; 404 wallet ausente                                               |
| `POST /wallets/:walletId/reconciliation`                                  | 200, diagnóstico; 404 ausente                                                                  |
| `POST /wagering/transactions`                                             | 200 PROCESSED; 202 PENDING/PENDING_REFERENCE; 422 REJECTED; resultado FAILED histórico usa 500 |
| `GET /wagering/transactions/:transactionId`                               | 200, transação externa; 404 ausente ou OPENING interno                                         |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200, transação externa; 404 ausente                                                            |
| `GET /health/live`                                                        | 200 `{ "status": "ok" }`, sem consulta ao banco                                                |
| `GET /health/ready`                                                       | 503 nesta etapa: verifica PostgreSQL, mas SQS ainda não foi implementado                       |

Os códigos HTTP são escolhas locais autorizadas pela Task 08; o enunciado exige distinguir as categorias, sem prescrever números. Uma rejeição persistida de negócio retorna resultado Wagering em 422, com transactionId/failureCode, e tem replay. Payload estrutural inválido retorna erro 400 sem criar transação de rejeição. PENDÊNCIAS não são reprocessadas por novo envio HTTP.

Health é aberto. Autenticação foi omitida nesta etapa, conforme escopo: `NoAuthGuard` no bootstrap é o ponto explícito de substituição por integração com IdP externo/OIDC. Não há usuários/senhas ou autenticação artesanal. Uma futura implementação deve preservar health aberto e verificar identidade do provider; validar o texto providerId não autentica seu emissor.

Readiness retorna, por exemplo, `503 { "status": "not_ready", "checks": { "postgres": "up", "sqs": "not_configured" } }`. Falha no banco muda postgres para down. Não existe readiness completo ou resposta 200 enquanto SQS estiver ausente; liveness permanece disponível após falha do banco. Startup ainda requer PostgreSQL acessível.

## Entrada e validação

Abertura recebe somente playerId e initialBalance:

```json
{
	"playerId": "player-demo",
	"initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Resposta 201 inclui id/playerId/currency/balance/version/createdAt/updatedAt. Balance usa MoneyProps, versão inicial é 1 e datas são ISO 8601 UTC. Inicial zero não grava transação nem ledger. Inicial positivo grava wallet → OPENING → CREDIT, atomicamente, sem evento Wagering. A constraint `wallets_player_currency_unique` protege criações concorrentes.

Submissão exige `Content-Type: application/json` e header explícito `Idempotency-Key`. Exemplo:

```json
{
	"providerId": "provider-a",
	"externalTransactionId": "transaction-123",
	"walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
	"playerId": "player-demo",
	"roundId": "round-987",
	"gameId": "fortune-chimp",
	"kind": "BET",
	"money": { "amount": "25.00", "currency": "BRL" }
}
```

O adapter converte money em amount do comando existente. Todas as identidades externas são texto não vazio, sem NUL ou surrogate isolado; Unicode válido permanece exato, sem normalização. IDs internos são UUIDs, normalizados em minúsculas. Não se impõe UUID a playerId/providerId/roundId/gameId/IDs externos. Kind externo admite BET/WIN/LOSS/REFUND/ROLLBACK, nunca OPENING. Referência é obrigatória nas reversões; null e ausência equivalem a ausência nas demais operações, preservando a política anterior.

Dinheiro exige string decimal sem sinal com exatamente duas casas e moeda no catálogo ISO local de Money. Number, NaN/Infinity, expoentes, negativos, escala inválida, moedas desconhecidas, arrays/objetos incorretos e campos não previstos falham com 400. Não há parseFloat, arredondamento, bigint bruto ou entidades ORM no JSON. Header não é derivado do body: exige valor único não vazio, sem espaços, controles ou vírgula. O servidor HTTP normaliza whitespace de borda dos headers; whitespace interno é rejeitado.

O HTTP exige walletId. O caso de uso verifica que ele corresponde à wallet resolvida por player/moeda, inclusive no replay, ou retorna WALLET_NOT_FOUND. Essa asserção preserva o hash canônico da Task 06, que exclui walletId derivado e metadados de transporte. Callers existentes sem walletId permanecem compatíveis. O controller não resolve wallet por conta própria.

## Idempotência e consultas

```json
{
	"transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
	"externalTransactionId": "transaction-123",
	"walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
	"status": "PROCESSED",
	"balance": { "amount": "75.00", "currency": "BRL" },
	"idempotentReplay": false
}
```

Replay mantém a mesma resposta e código HTTP do resultado, com idempotentReplay true e saldo histórico, mesmo após outras movimentações. Mesma key/payload divergente retorna 409 IDEMPOTENCY_CONFLICT. Mesmo provider/ID externo com outra key retorna 409 EXTERNAL_TRANSACTION_CONFLICT; não cria nova REJECTED. Providers distintos têm escopos independentes. Hash e igualdade seguem integralmente o [contrato canônico](domain/wagering.md#entrada-saída-e-identidade).

Consultas de transação enumeram transactionId/providerId/externalTransactionId/walletId/playerId/roundId/gameId/kind/money/status, referências e failureCode quando presentes, createdAt e processedAt quando aplicável. Não expõem key/hash, metadados SQL ou saldo atual como se fosse histórico. OPENING pode ser auditado pelo ledger; não é entidade externa Wagering.

Ledger retorna itens com id/walletId/transactionId/direction/money/balanceBefore/balanceAfter/createdAt. Ordenação crescente `(created_at,id)`; limit padrão 50, intervalo 1–100, inteiro. Cursor opaco contém âncora imutável vinculada à wallet; clientes devem devolver nextCursor sem interpretá-lo. O banco obtém o timestamp da própria linha âncora, preservando microssegundos que Date/ISO JavaScript não representam. A página usa snapshot consistente; várias páginas não constituem um snapshot único contra novas inserções. O cursor não é credencial nem assinatura de autorização. nextCursor null encerra a leitura; cursor estruturalmente inválido ou de outra wallet retorna 400 INVALID_CURSOR. Filtros/query fields desconhecidos são rejeitados.

## Reconciliação

```json
{
	"walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
	"storedBalance": { "amount": "75.00", "currency": "BRL" },
	"calculatedBalance": { "amount": "75.00", "currency": "BRL" },
	"difference": { "amount": "0.00", "currency": "BRL" },
	"consistent": true,
	"checkedEntries": 2
}
```

Reconstrói desde zero, somando créditos e subtraindo débitos por Money exato, incluindo OPENING e reversões. LOSS e rejeições não têm lançamento. `difference = storedBalance - calculatedBalance`, com sinal preservado, inclusive negativo. Cada lançamento é validado pelo mapper/domínio; a continuidade entre saldos também é conferida. Timestamps distintos ordenam grupos; empates em milissegundos admitem uma cadeia válida de saldos, sem supor ordem financeira por UUID. Ciclos desconectados são inconsistentes mesmo que a soma coincida. Por isso consistent false também pode acompanhar diferença zero.

Wallet e ledger são lidos na mesma execução de UnitOfWork com `{ readOnly: true }`: fork transacional, isolamento REPEATABLE READ e SET TRANSACTION READ ONLY. O snapshot é estabelecido na leitura da wallet e preservado na leitura do ledger, mesmo com commit concorrente. Não usa FOR UPDATE nem commit aninhado. Escritas normais mantêm READ COMMITTED e seus locks anteriores.

Divergência não modifica wallet, ledger, versão ou Outbox. Gera log JSON seguro com event/walletId e incremento do contador de divergências da instância (`WalletReconciliationDiagnostics`). O contador é consultável pela composição/DI, não é durável nem agregado entre processos; exportação de métricas de produção e observabilidade completa ficam para etapa própria. Reconciliação lê todo o histórico em memória, sem teto financeiro/comercial inventado; histórico muito grande exigirá leitura incremental mantendo o mesmo snapshot.

## Erros

Erros de entrada/aplicação/infraestrutura usam `{ "statusCode": 400, "code": "INVALID_REQUEST" }`, com categoria/código correspondente. Nunca expõem SQL, mensagens internas, stack, credenciais ou configuração.

| HTTP | code                                                                       |
| ---- | -------------------------------------------------------------------------- |
| 400  | INVALID_REQUEST, INVALID_WALLET_INPUT, INVALID_CURSOR                      |
| 404  | WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND, NOT_FOUND                         |
| 409  | WALLET_ALREADY_EXISTS, IDEMPOTENCY_CONFLICT, EXTERNAL_TRANSACTION_CONFLICT |
| 503  | SERVICE_UNAVAILABLE, IDEMPOTENCY_IN_PROGRESS                               |
| 500  | INTERNAL_ERROR                                                             |

Somente SQLSTATE 23505 **e** constraint wallets_player_currency_unique viram WALLET_ALREADY_EXISTS. Outras constraints inesperadas permanecem 500; adapters preservam os erros SQL originais. Indisponibilidade reconhece classe 08, encerramento/recovery/saturação PostgreSQL, conflitos transitórios de lock/serialização e códigos conhecidos de rede. Os dois timeouts sem código do pg-pool também são reconhecidos pelo texto exato da biblioteca instalada. Não há retry automático. Erros HTTP do parser, inclusive JSON malformado, são sanitizados. Limites do parser/servidor podem produzir outros status HTTP, como 413.

Failure codes nas respostas REJECTED são os de [Wagering](domain/wagering.md#failure-codes-estáveis), sem taxonomia paralela de transporte.

## Exemplos curl reproduzíveis

Após setup/migrations do [README](../README.md), execute em Bash, com Bun e curl no PATH. Use player/identidade novos se repetir a demonstração:

```sh
BASE=http://localhost:3000
PLAYER="demo-$(bun -e 'console.log(crypto.randomUUID())')"
WALLET_ID=$(curl --fail-with-body -sS "$BASE/wallets" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | bun -e 'console.log((await Bun.stdin.json()).id)')
TX="bet-$(bun -e 'console.log(crypto.randomUUID())')"
BODY="{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$TX\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
curl -i "$BASE/wagering/transactions" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: provider-a:$TX" -d "$BODY"
# Repetir: saldo histórico 75.00, idempotentReplay true.
curl -i "$BASE/wagering/transactions" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: provider-a:$TX" -d "$BODY"
curl -sS "$BASE/wallets/$WALLET_ID"
curl -sS "$BASE/wallets/$WALLET_ID/ledger?limit=50"
curl -sS "$BASE/providers/provider-a/wagering/transactions/$TX"
curl -sS -X POST "$BASE/wallets/$WALLET_ID/reconciliation"
curl -i "$BASE/health/live"
curl -i "$BASE/health/ready" # 503: SQS não configurado nesta etapa.
```

## Evidências e limites

`bun test test/wallet-use-cases.test.ts test/http-input.test.ts` cobre aplicação e validação. `bun test test/http-api.test.ts` usa Nest e PostgreSQL descartável reais, abertura/falhas/reversões/paginação/erros/replay/Outbox/reconciliação. `bun test test/http-concurrency.test.ts` usa três servidores Bun independentes, barreiras transacionais e observação de espera SQL: 100/80/80, 50 duplicatas, wallets distintas, abertura concorrente, snapshot e perda da resposta após commit. A suíte completa mantém os crashes anteriores e regressões financeiras da Task 07. [Relatório](task08-http-report.md).

Nenhum SQS/LocalStack, Inbox, publisher, worker, DLQ ou retry foi implementado. Outbox permanece PENDING. Pendências Wagering não evoluem sem o futuro worker; não se anuncia entrega exactly-once ou readiness completo.
