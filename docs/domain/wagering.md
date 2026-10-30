# Wagering: operações, estados e idempotência

O [enunciado §§6.3 e 7](../challenge.md) define as operações externas.
[WagerTransaction](../../src/modules/wagering/domain/wager-transaction.ts)
encapsula identidade e transições; a aplicação coordena referências, Wallet e
persistência. Financial é acessado somente por seu public.

## Operações

| Kind     | Consequência        | Condição                                                                           |
| -------- | ------------------- | ---------------------------------------------------------------------------------- |
| BET      | DEBIT               | Saldo suficiente                                                                   |
| WIN      | CREDIT              | Pode informar referência a uma BET do mesmo contexto; valor do prêmio pode diferir |
| LOSS     | NONE                | Registra resultado, inclusive com valor zero; sem ledger ou versão nova            |
| REFUND   | CREDIT              | Referência obrigatória a BET PROCESSED, valor integral igual                       |
| ROLLBACK | Inverso             | Referência obrigatória a BET, WIN ou REFUND PROCESSED, valor integral igual        |
| OPENING  | Interno a Financial | Não pertence ao tipo externo; proibido por HTTP/SQS                                |

`processingDecision(reference?)` consulta um plano sem mutação. READY contém
`FinancialConsequence` imutável (DEBIT/CREDIT com Money, ou NONE sem dinheiro).
A aplicação aplica a consequência pela Wallet; `markProcessed` verifica novamente
a decisão e conclui a entidade. Uma consulta repetida não movimenta saldo.
`saveWagerBalanceChange` associa o BalanceChange ao ledger quando houver mudança.

## Identidade e referências

IDs internos são UUIDs canônicos em minúsculas. Provider, player, round, game,
ID externo e key são textos não vazios, sem NUL e com Unicode bem formado.
Unicode válido é preservado, sem normalização. Surrogates isolados são rejeitados
antes do hash/SQL para evitar que identidades distintas colapsem na conversão UTF-8.
Datas entram e saem por cópias; a entidade é congelada, com estado privado.

A referência é buscada por `(providerId, referenceExternalTransactionId)` e deve
ter o mesmo provider, player, wallet, moeda e rodada. `gameId` não precisa coincidir.
Autorreferência é inválida. WIN pode referenciar somente BET; REFUND somente BET;
ROLLBACK somente BET/WIN/REFUND. LOSS não admite referência. Reversões exigem
igualdade exata de valor; reversão parcial está fora do escopo.

O chamador fornece a referência e o histórico completo de reversões PROCESSED
sob o lock da wallet. Histórico omitido/inválido não equivale a uma lista vazia.
Referência de outra wallet é lida e rejeitada sem adquirir lock financeiro nela.
A entidade não consulta banco nem marca a operação original como revertida.

## Políticas e reversões

Políticas atuais. Zero e insuficiência preservam a Task 06; a compensação ativa
foi aprovada explicitamente na Task 12.1:

- BET/WIN/REFUND/ROLLBACK com zero são REJECTED por ZERO_AMOUNT_NOT_ALLOWED.
  LOSS aceita valor não negativo e não produz movimento.
- Cada par referência/modalidade pode ter somente uma reversão PROCESSED no
  histórico. Repetir a modalidade produz DUPLICATE_REVERSAL, mesmo depois de
  neutralizar seu efeito. Rejeições não consomem essa unicidade.
- Uma BET admite no máximo uma compensação direta ativa. Outra modalidade
  enquanto o crédito anterior está ativo produz CUMULATIVE_REVERSAL_NOT_ALLOWED.
  Somente fatos PROCESSED compatíveis podem demonstrar neutralização.
- ROLLBACK de REFUND aponta para outra transação: debita o crédito daquele REFUND,
  uma única vez. Depois desse débito confirmado, um ROLLBACK direto da BET pode
  processar se essa modalidade ainda não tiver sido processada para a BET.
  O histórico de REFUND permanece intacto; um novo REFUND continua duplicado.
- Débito de reversão sem saldo gera REVERSAL_INSUFFICIENT_BALANCE, distinto da
  insuficiência de BET, e preserva saldo, versão e ledger.

Exemplo com saldo inicial 100.00 e BET 80.00: BET deixa 20.00; REFUND da BET
restaura 100.00; ROLLBACK do REFUND debita para 20.00; ROLLBACK da BET credita
para 100.00. Cada PROCESSED tem movimento integral, incremento de versão e ledger.
Não existe segunda modalidade PROCESSED sem efeito nem crédito direto sobre
compensação ainda ativa. ROLLBACK de ROLLBACK continua proibido; por isso a cadeia
inversa não oferece neutralização equivalente.

O §7.4 define unicidade por tipo, mas não especifica a combinação de compensações
ativas entre tipos. A distinção entre unicidade histórica e compensação ativa é
interpretação adicional aprovada, preservando a tabela de movimentos e evitando
compensação líquida superior ao valor da BET. A
[análise e matriz de cenários](../history/reports/task12-1-re03-conformance-report.md)
separam texto literal, inferência e decisão. A correção não reabre rejeições
antigas: uma tentativa anteriormente rejeitada continua retornando esse resultado;
para tentar após neutralização é necessária outra operação/identidade.

O domínio recebe `refundReversed` junto do histórico sob lock da wallet. O adapter
confirma REFUND e seu ROLLBACK PROCESSED, referências internas/externas e igualdade
de provider, player, wallet, moeda, rodada e valor. Uma tentativa rejeitada,
pendente ou incompatível não neutraliza o REFUND. A
[proteção SQL](../persistence.md#integridade) aplica a mesma regra em novas
operações processadas; HTTP, SQS e resolver usam o mesmo motor.

## Estados e transições

| Origem                      | Transições válidas                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Criação                     | PENDING                                                                                       |
| PENDING                     | PENDING_REFERENCE se lookup ausente; PROCESSED quando elegível; REJECTED ou FAILED explícitos |
| PENDING_REFERENCE           | PROCESSED quando elegível; REJECTED ou FAILED explícitos                                      |
| PROCESSED, REJECTED, FAILED | Nenhuma nova decisão/transição                                                                |

Repetir `markPendingReference` é erro; não há transição de volta para PENDING.
Reidratação valida estrutura/coerência sem reaplicar efeitos, consultar histórico
ou reavaliar a aceitação histórica de zero. `processedAt` existe somente para
PROCESSED e não antecede criação; REJECTED/FAILED exigem código. A
[proteção SQL de terminais](../persistence.md#imutabilidade-e-migrations)
impede alteração/exclusão por acesso direto, além da guarda no domínio/repository.

FAILED é suportado por `fail(code)`, persistência e consultas. Erros SQL/conexão
inesperados propagam rollback; não há classificação genérica automática em FAILED.
Erros de entrada não fabricam transações rejeitadas. FailureCode de negócio é
persistido para decisões auditáveis.

## Entrada, saída e identidade

[ProcessWagerCommand](../../src/modules/wagering/public/process-wager.ts) contém
providerId, externalTransactionId, idempotencyKey, playerId, roundId, gameId, kind,
`amount: MoneyProps` e referência opcional. Wallet é resolvida por player/moeda.
HTTP/SQS exigem walletId; callers internos anteriores podem omiti-lo. Quando
informado, deve coincidir com a wallet resolvida, inclusive em replay, ou ocorre
WALLET_NOT_FOUND. Ele é uma asserção da identidade derivada e não integra o hash.

Scope = `wagering:v1:` seguido de JSON.stringify(providerId).
[prepareWager](../../src/modules/wagering/application/canonical-wager.ts) valida e
captura os campos antes de aguardar SHA-256. O hash hexadecimal minúsculo é dos
bytes UTF-8 de JSON.stringify com esta allowlist em ordem lexicográfica:
`amount`, `externalTransactionId`, `gameId`, `kind`, `playerId`, `providerId`,
`referenceExternalTransactionId`, `roundId`. O objeto amount contém `amount`
decimal canônico e `currency`. Referência ausente/null vira null. Texto não é
normalizado. Key, walletId e metadados de transporte ficam fora do hash.

Mesmo scope/key/hash retorna original_result com idempotentReplay true. Hash
diferente é IDEMPOTENCY_CONFLICT. Mesmo provider/ID externo com outra key é
EXTERNAL_TRANSACTION_CONFLICT mesmo quando o payload coincide; não é replay.
Providers distintos têm identidades independentes. O header HTTP é obrigatório
e prevalece sobre qualquer sugestão de key; o body não contém key no HTTP.

A reserva IN_PROGRESS e a conclusão COMPLETED pertencem à mesma transação. Também
resultados pendentes e rejeitados são COMPLETED, sem key presa em processamento.
PROCESSED guarda saldo histórico; REJECTED/FAILED guardam failureCode; pendências
guardam motivo/identidade observada. Todo resultado contém transactionId,
externalTransactionId, walletId e idempotentReplay. Só há retorno confirmado após
commit. [Ordem de locks e unicidade](../architecture/concurrency.md).

## Resolução de referências

[ProcessWagerUseCase](../../src/modules/wagering/application/process-wager.use-case.ts)
recebe novas entradas/Inbox; [ResolvePendingWagerUseCase](../../src/modules/wagering/application/resolve-pending-wager.use-case.ts)
resolve a entidade existente. Ambos usam [processWager](../../src/modules/wagering/application/process-wager.ts),
Wallet, BalanceChange e a mesma inserção de ledger/eventos. O resolver não cria
nova identidade, key ou WagerTransaction.

| Referência atual, após validar contexto/tipo/valor     | Antes do TTL                     | Depois do TTL                                |
| ------------------------------------------------------ | -------------------------------- | -------------------------------------------- |
| Ausente                                                | PENDING_REFERENCE; NOT_FOUND     | REJECTED / REFERENCE_NOT_FOUND_EXHAUSTED     |
| PENDING/PENDING_REFERENCE compatível                   | Esperar; NOT_PROCESSED           | REJECTED / REFERENCE_NOT_PROCESSED_EXHAUSTED |
| PROCESSED compatível e elegível                        | Aplicar operação                 | Aplicar operação                             |
| REJECTED/FAILED compatível                             | REFERENCE_TERMINAL_INELIGIBLE    | Mesma rejeição                               |
| Incompatível, duplicada/cumulativa ou débito sem saldo | Código de negócio correspondente | Mesmo código                                 |

Uma entrada nova cuja referência já existe não terminal permanece PENDING, com
FK nula e motivo NOT_PROCESSED no resultado. Se ela inexiste, é PENDING_REFERENCE.
O worker seleciona os dois estados com referência externa; não seleciona OPENING
ou PENDING sem referência. Em espera, preserva o snapshot aceito e o estado;
PENDING pode ir a PENDING_REFERENCE se o lookup passar a ser ausente. Não emite
outro evento de polling/espera.

TTL aprovado: **24 horas desde created_at**, configurável. Backoff exponencial
com jitter entre mínimo e teto, padrões 1s e 5min; não há teto adicional de attempts.
O prazo acomoda entregas fora de ordem sem manter referência ausente indefinidamente.
É avaliado em tentativa elegível, sujeito a scheduling e disponibilidade SQL.
Após vencer, a referência é revalidada: uma original já elegível ainda é aplicada.
Falha técnica reverte e agenda retry; não expira uma operação por erro técnico.

O commit terminal atualiza resultado idempotente, efeitos aplicáveis, novos fatos
Outbox e a linha Wagering/limpeza do claim. Fencing final falho reverte tudo.
Replay anterior retorna pendente; durante a resolução espera idempotência; após
commit retorna o terminal e seu saldo histórico. A Inbox já concluída permanece
concluída: repetir a mesma entrega deduplica, enquanto mensagem nova da operação
observa o resultado idempotente atualizado. O evento antigo de pendência é imutável.
[Operação/configuração](../operations/pending-worker.md).

## Failure codes estáveis

| Código                            | Decisão                                     |
| --------------------------------- | ------------------------------------------- |
| BET_INSUFFICIENT_BALANCE          | BET sem saldo                               |
| REVERSAL_INSUFFICIENT_BALANCE     | Débito de reversão sem saldo                |
| ZERO_AMOUNT_NOT_ALLOWED           | Zero financeiro conforme política           |
| INCOMPATIBLE_REFERENCE            | Contexto, tipo ou valor incompatível        |
| REFERENCE_TERMINAL_INELIGIBLE     | Referência REJECTED/FAILED                  |
| DUPLICATE_REVERSAL                | Mesma modalidade já processada              |
| CUMULATIVE_REVERSAL_NOT_ALLOWED   | Outra compensação direta permanece ativa    |
| REFERENCE_NOT_FOUND_EXHAUSTED     | Referência ausente na revalidação após TTL  |
| REFERENCE_NOT_PROCESSED_EXHAUSTED | Referência compatível não terminal após TTL |

IDEMPOTENCY_CONFLICT, EXTERNAL_TRANSACTION_CONFLICT, IDEMPOTENCY_IN_PROGRESS e
WALLET_NOT_FOUND são erros de aplicação, sem criar nova rejeição. Códigos SQL e
exceções técnicas não são convertidos em failureCode financeiro.

## Verificação

[Testes de domínio](../../test/wager-transaction.test.ts) verificam factories,
transições, referências, valores, terminalidade e imutabilidade. [Caso de uso](../../test/process-wager.test.ts)
verifica políticas, hash/replay e falhas. [PostgreSQL](../../test/process-wager-persistence.test.ts),
[worker SQL](../../test/pending-persistence.test.ts) e [três workers](../../test/pending-distributed.test.ts)
verificam efeitos únicos, TTL/fencing, replay concorrente e reconciliação.
Resultados da baseline ficam no [relatório da auditoria](../history/reports/task12-audit-report.md);
a correção de RE-03 e sua validação estão na [Task 12.1](../history/reports/task12-1-re03-conformance-report.md).
