# Wagering: operações, estados e idempotência

## Task 06 — políticas e contrato aprovados

As decisões locais abaixo foram aprovadas na Task 06; complementam §§6–9 do desafio, sem serem exigências literais adicionais do original.

- Zero: BET/WIN/REFUND/ROLLBACK são REJECTED com `ZERO_AMOUNT_NOT_ALLOWED`; LOSS zero é PROCESSED sem saldo, versão ou ledger.
- Primeira reversão direta PROCESSED de uma BET prevalece: REFUND e ROLLBACK não acumulam. Mesma modalidade é `DUPLICATE_REVERSAL`; outra modalidade é `CUMULATIVE_REVERSAL_NOT_ALLOWED`. ROLLBACK de REFUND tem outra referência e permanece permitido; somente reversões PROCESSED entram no histórico.
- Ausência da referência: PENDING_REFERENCE, FK interna nula, `pendingReference.reason = NOT_FOUND`. Referência encontrada PENDING/PENDING_REFERENCE: persistir PENDING, FK nula, resultado `pendingReference.reason = NOT_PROCESSED`, com ID/status observado. Isso distingue ausência de processamento em andamento sem estado SQL novo. Referência REJECTED/FAILED é rejeição `REFERENCE_TERMINAL_INELIGIBLE`. Sem espera síncrona, worker, TTL ou backoff nesta etapa.
- Falhas técnicas propagam com rollback integral. Não há retry interno nem classificação genérica em FAILED; persistência permite FAILED para uma futura classificação permanente explícita.

### Entrada, saída e identidade

`ProcessWagerUseCase.execute(ProcessWagerCommand)` recebe providerId, externalTransactionId, idempotencyKey, playerId, roundId, gameId, kind externo, `amount: MoneyProps` e referenceExternalTransactionId opcional. Resolve wallet por player/moeda. A Task 08 acrescenta walletId opcional para compatibilidade com callers anteriores e obrigatório no HTTP conforme §9: valida UUID e exige igualdade com a wallet resolvida ou com a wallet do resultado em replay; divergência retorna WALLET_NOT_FOUND sem novos efeitos. Isso é uma asserção sobre a identidade derivada e não altera o hash histórico. Identidades obrigatórias mantêm texto exato não vazio/sem NUL; referência null e ausente equivalem a ausência. Todos os textos precisam de Unicode bem formado: surrogates isolados são rejeitados antes de SQL, pois conversão UTF-8 poderia colapsar identidades. Unicode válido não é normalizado. OPENING e estrutura inválida são erros de aplicação/entrada, sem transação rejeitada artificial.

Resultado discriminado por status contém transactionId, externalTransactionId, walletId e idempotentReplay. PROCESSED inclui balance MoneyProps observado sob lock; REJECTED/FAILED incluem failureCode; PENDING/PENDING_REFERENCE incluem pendingReference. Pendências e rejeições não prometem saldo financeiro. Sucesso só retorna depois do commit.

Scope = `wagering:v1:` seguido de JSON.stringify do providerId validado (string JSON, sem ambiguidade por delimitadores). UNIQUE(scope,key) isola providers. Hash SHA-256 dos bytes UTF-8 do JSON canônico com campos explicitamente enumerados nesta ordem lexicográfica: amount (objeto com amount decimal normalizado e currency), externalTransactionId, gameId, kind, playerId, providerId, referenceExternalTransactionId (null na ausência), roundId. Sem normalização Unicode/textual, sem idempotencyKey, walletId derivado ou metadados de transporte. Snapshot validado antes de awaits; não aceitar hash do cliente.

Mesma scope/key/hash: resultado armazenado com replay true. Hash divergente: `IDEMPOTENCY_CONFLICT`, sem WagerTransaction nova. Mesmo provider/externalTransactionId com outra key: `EXTERNAL_TRANSACTION_CONFLICT`, mesmo com payload igual, informa ID existente e igualdade de payload; não é replay nem nova rejeição. Providers distintos têm identidades independentes. Wallet ausente é `WALLET_NOT_FOUND` de aplicação.

Reserva IN_PROGRESS existe somente dentro da transação ainda não confirmada. Ao confirmar qualquer resposta, inclusive pendente, gravar COMPLETED com resultado e FK. Replays pendentes devolvem o snapshot aceito sem tentar processar novamente; jamais deixam key presa em IN_PROGRESS. Futuro worker deverá adquirir a mesma ordem de locks, processar a entidade não terminal e substituir atomicamente apenas resultado pendente por terminal no mesmo registro. PROCESSED é snapshot histórico imutável; não substituir saldo original pelo saldo atual. Essa evolução exige porta de atualização condicionada futura e não é implementada nesta etapa.

### Locks e integridade

Ordem única: reserva scope/key via INSERT ON CONFLICT e lock da linha → advisory transaction lock da identidade externa `(provider,external)` → busca da identidade existente → resolução e FOR UPDATE da wallet → leitura da referência/histórico → gravação Wagering → wallet/ledger quando mudam → conclusão idempotente → commit. Advisory usa hash PostgreSQL de tupla JSON com namespace; colisões apenas serializam identidades adicionais, sem afetar correção. Nenhum lock global. Não se adquire outra key ou identidade durante essa execução.

O lock da wallet é o recurso comum de toda referência elegível. Não bloquear uma referência de outra wallet: ler e rejeitar incompatibilidade antes de efeitos. Toda atualização futura de estado de referência deve respeitar primeiro o lock da própria wallet. Leituras após aquisição usam READ COMMITTED e refresh. Assim, a original confirma antes da reversão ou esta observa ausência/pendência recuperável; não há aquisição inversa de linhas de referência. FK determina Wagering antes de ledger e conclusão idempotente após Wagering.

Migration adicional cria UNIQUE(reference_transaction_id) parcial para REFUND/ROLLBACK PROCESSED, além do índice por modalidade existente. Protege também SQL direto contra reversões cumulativas; rejeições não entram no predicado. ROLLBACK de REFUND aponta para outra transação. Migration falha se houver histórico cumulativo incompatível, sem apagar dados; down remove somente esse índice.

### Failure codes estáveis

| Código                          | Decisão                                                  |
| ------------------------------- | -------------------------------------------------------- |
| BET_INSUFFICIENT_BALANCE        | BET sem saldo                                            |
| REVERSAL_INSUFFICIENT_BALANCE   | ROLLBACK de crédito sem saldo                            |
| ZERO_AMOUNT_NOT_ALLOWED         | Zero em operação financeira                              |
| INCOMPATIBLE_REFERENCE          | Contexto, modalidade ou valor da referência incompatível |
| REFERENCE_TERMINAL_INELIGIBLE   | Referência REJECTED/FAILED                               |
| DUPLICATE_REVERSAL              | Mesma modalidade já PROCESSED                            |
| CUMULATIVE_REVERSAL_NOT_ALLOWED | Outra reversão direta já PROCESSED                       |
| REFERENCE_NOT_FOUND_EXHAUSTED   | Reservado ao worker futuro; não emitido nesta etapa      |

`IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `WALLET_NOT_FOUND` são erros de aplicação, não failureCode de nova transação. Exceções SQL/lock/conexão preservam causa/código, não expõem payload completo e não são convertidas em rejeição. Não há interface de logging apropriada existente; resultados/erros tipados fornecem identidade segura para os adapters futuros.

Requisitos **explícitos** dos §§3, 6.0, 6.3–6.4, 7–11 e 13 de [challenge.md](../challenge.md). O original permanece primário e imutável. A [Arquitetura](../../ARCHITECTURE.md) aprova [ProcessWagerUseCase](../../src/modules/wagering/application/process-wager.use-case.ts) como orquestrador compartilhado por HTTP e futura entrada SQS. Domínio, caso de uso, idempotência, efeitos transacionais, eventos Outbox e HTTP estão implementados. Publicação e SQS continuam futuros.

A [integração financeira](../persistence.md#integração-financeira-e-unitofwork) participa do mesmo contexto estendido com WagerTransactionRepository e IdempotencyRepository. `insertProcessed` permanece compatível com os testes anteriores; o processador usa entidades e mappers explícitos. OPENING continua interno a Financial, sobre armazenamento técnico compartilhado; não pertence ao tipo público de operação do provider.

## Operações (§§6.3–6.4, 7, 9)

| Kind     | Efeito / ledger quando aplicável              | Referência e condição explícita                                         |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| BET      | Débito / uma DEBIT                            | Rejeitar saldo insuficiente                                             |
| WIN      | Crédito / uma CREDIT                          | Pode referenciar BET da mesma rodada                                    |
| LOSS     | Sem saldo / sem ledger                        | Registra resultado e evento WagerTransactionProcessed na Outbox         |
| REFUND   | Crédito / uma CREDIT                          | Exige BET PROCESSED; mesmo valor, reversão integral                     |
| ROLLBACK | Inverso da referência / uma entrada invertida | Exige BET, WIN ou REFUND PROCESSED; mesmo valor, reversão integral      |
| OPENING  | Crédito interno de abertura / CREDIT          | Inicial positivo, mesma transação SQL da wallet; proibido em API e fila |

Contratos de Money, saldo/versão e ledger pertencem a [Financial](financial.md). Transação REJECTED não altera saldo nem gera ledger. Não introduzir fluxos financeiros independentes nos adapters de transporte.

## Identidade e referências (§§6.3, 7–7.1)

Modelo de referência registra id interno, providerId, externalTransactionId, idempotencyKey, payloadHash, walletId, playerId, roundId, gameId, kind, Money, referenceExternalTransactionId, createdAt, status, referenceTransactionId interno resolvido, failureCode e processedAt. Estado encapsulado com factories; rehydrate não reaplica transições (§6.0).

- REFUND/ROLLBACK exigem referenceExternalTransactionId, **ID externo do provedor**, não ID interno.
- Resolver por `(providerId, referenceExternalTransactionId)`; referência deve compartilhar provider, player, wallet, moeda e rodada. O §7 não exige mesmo gameId; não adicionar essa restrição.
- REFUND só referencia BET; ROLLBACK somente BET/WIN/REFUND. A referência deve estar PROCESSED para ser revertida.
- O desafio proíbe repetir a mesma modalidade; a política adicional aprovada da Task 06 também proíbe modalidades cumulativas diretas. O núcleo mantém `POLICY_REQUIRED/CROSS_TYPE_REVERSAL`; a aplicação traduz em rejeição auditável conforme a política acima.
- REFUND/ROLLBACK devem igualar o valor referenciado; reversão parcial fora do escopo.
- Referência ausente exige PENDING_REFERENCE persistente e evento correspondente; worker agendado reprocessa com backoff exponencial.
- Definir e justificar tentativas ou TTL. Ao esgotar, REJECTED com código que identifique referência inexistente e evento de rejeição. Valores e política de aquisição concorrente permanecem pendentes.
- Reversão que produziria saldo negativo é rejeitada auditavelmente, com failureCode **distinto** da BET sem saldo. A taxonomia da Task 06 está definida acima.

## Estados e transições (§6.3)

| Estado            | Semântica explícita                           | Terminal |
| ----------------- | --------------------------------------------- | -------- |
| PENDING           | Aceita, ainda não aplicada; estado de criação | Não      |
| PENDING_REFERENCE | Aguardando referência ausente; persistente    | Não      |
| PROCESSED         | Aplicada                                      | Sim      |
| REJECTED          | Violação de negócio                           | Sim      |
| FAILED            | Erro permanente de infraestrutura, auditável  | Sim      |

| Origem → destino                         | Base / classificação                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| Criação → PENDING                        | Explícito (§6.3)                                                                  |
| PENDING → PENDING_REFERENCE              | Referência ausente (§7)                                                           |
| PENDING ou PENDING_REFERENCE → PROCESSED | Aplicação bem-sucedida, inclusive resolução pelo worker (§§6.3, 7.1)              |
| PENDING ou PENDING_REFERENCE → REJECTED  | Violação de negócio; inclui esgotamento de referência (§§6.3, 7–7.2)              |
| Estado terminal → qualquer transição     | Proibido; erro de programação, conforme InvalidTransactionStateError do esqueleto |
| Não terminal → FAILED                    | Destino permanente explícito; classificação/esgotamento exatos pendentes          |

A implementação detalha esses caminhos na matriz abaixo. Falha transitória não é automaticamente FAILED terminal. Reidratar e retornar replay não são transições de estado.

| Origem                        | `markPendingReference`                        | `markProcessed`                                   | `reject`                      | `fail`                      |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------- | ----------------------------- | --------------------------- |
| PENDING                       | PENDING_REFERENCE somente para lookup ausente | PROCESSED somente com decisão READY e data válida | REJECTED com código fornecido | FAILED com código fornecido |
| PENDING_REFERENCE             | Proibida repetição                            | PROCESSED diretamente quando READY                | REJECTED com código fornecido | FAILED com código fornecido |
| PROCESSED / REJECTED / FAILED | Proibida                                      | Proibida                                          | Proibida                      | Proibida                    |

Escolhas locais de implementação: não há retorno intermediário a PENDING; repetir a transição de espera é erro, evitando que uma nova transição pareça um novo evento. Consultar novamente `processingDecision` enquanto não terminal é permitido e não altera estado. `createdAt` e `processedAt` usam datas explícitas, sem relógio implícito; processamento não antecede criação. Datas são copiadas na entrada/saída. `reject`/`fail` não recebem consequência financeira e não preenchem `processedAt`. Toda validação precede mutação.

Referência encontrada não PROCESSED retorna `REFERENCE_NOT_PROCESSED` com o estado observado. A aplicação mantém PENDING quando a referência está em processamento e rejeita referência terminal inelegível. `markPendingReference(found)` e `markProcessed(at, found)` não os aceitam; essa diferença permanece explícita no resultado persistido.

## API pública implementada

Entrada: [public/index.ts](../../src/modules/wagering/public/index.ts). A [entidade](../../src/modules/wagering/domain/wager-transaction.ts) importa somente Money pelo public de Financial e tipos/erros do próprio domínio. Não há dependência de Wallet, ORM, NestJS ou UnitOfWork concreto, nem novo value object monetário duplicando Money.

`WagerInput` reúne os dados de negócio anteriores à resolução da wallet. `WagerTransaction.validateInput(input)` compartilha a validação estrutural, inclusive Unicode, com a canonicalização e as factories; não cria entidade nem exige UUID/hash fictícios. UUID, wallet, hash e data são acrescentados na criação da transação real. Reidratação continua sem reaplicar efeitos ou transições.

| Contrato           | API / responsabilidade                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WagerTransaction` | `create(props)`, `rehydrate(state)`; consultas de identidade, money/currency, status, referência interna/externa, failureCode e datas                                            |
| Consultas          | `isTerminal()`, `requiresReference()` (REFUND/ROLLBACK), `matchesPayload(hash)` por igualdade opaca; sem algoritmo de hash ou decisão de replay                                  |
| Avaliação          | `processingDecision(reference?)`: READY com consequência e ID interno; PENDING_REFERENCE; REFERENCE_NOT_PROCESSED com status; POLICY_REQUIRED com política pendente              |
| Transições         | `markProcessed(at, reference?)` retorna consequência tipada; `markPendingReference(reference?)`; `reject(code)` e `fail(code)`                                                   |
| `WagerReference`   | `transaction` encontrada e `processedReversalKinds` completo para essa referência, fornecidos pelo chamador                                                                      |
| Tipos              | `CreateWagerTransactionProps`, `WagerTransactionState`, `WagerTransactionKind`, `WagerTransactionStatus`, `WagerReversalKind`, `FinancialConsequence`, `WagerProcessingDecision` |

Identidades internas UUID são normalizadas em minúsculas, coerentes com a igualdade UUID no banco. Provider/player/round/game/IDs externos/key/hash são textos obrigatórios não vazios e sem NUL; não são convertidos em UUID nem normalizados. Round/game são obrigatórios nas operações externas, conforme contrato HTTP e schema; não herdam a nulabilidade técnica de OPENING. A moeda é exclusivamente a do Money imutável, evitando campos monetários divergentes. A entidade é congelada, com estado mutável apenas em campos privados e sem setters.

`rehydrate` verifica estrutura e coerência (estado conhecido, código para REJECTED/FAILED, data apenas para PROCESSED, referência interna resolvida para operação processada que declara referência, ausência de FK em PENDING_REFERENCE). Não chama transições, não consulta histórico, não exige elegibilidade histórica da referência e não reaplica regras de aceitação de zero. Pode reconstruir registros históricos zero. Não reconstrói OPENING: esse registro pertence a Financial.

Erros distinguíveis em [errors.ts](../../src/modules/wagering/domain/errors.ts): `InvalidWagerOperationError`, `InvalidWagerStateError`, `ForbiddenWagerTransitionError`, `IncompatibleWagerReferenceError`, `InvalidWagerReversalError`, `WagerFinancialInvariantError` e `WagerDecisionRequiredError`. Não são exceções HTTP. `reject`/`fail` exigem texto não vazio fornecido pelo chamador; a aplicação faz o mapeamento para os códigos estáveis acima.

## Consequências e invariantes implementadas

`FinancialConsequence` é uma união imutável: `{ direction: 'DEBIT' | 'CREDIT', money: Money }` ou `{ direction: 'NONE' }`. NONE não contém dados de ledger. Uma decisão READY é um plano sem efeitos; consultar o plano repetidamente não aplica débito/crédito. `markProcessed` valida novamente e só conclui uma vez. Chamá-lo em estado terminal, inclusive após reidratação, falha sem produzir nova consequência.

| Operação elegível                         | Direção        | Base / limites                                                                                               |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| BET positiva                              | DEBIT          | Saldo suficiente verificado na Wallet pela aplicação                                                         |
| WIN positiva                              | CREDIT         | Referência opcional informada deve resolver BET no mesmo contexto; valor do prêmio não precisa igualar a BET |
| LOSS não negativa                         | NONE           | Registro de resultado sem movimentação, inclusive valor zero                                                 |
| REFUND positiva de BET PROCESSED          | CREDIT         | Mesmo valor integral e contexto; sem reversão direta PROCESSED anterior                                      |
| ROLLBACK positiva de BET PROCESSED        | CREDIT         | Inverso do débito original                                                                                   |
| ROLLBACK positiva de WIN/REFUND PROCESSED | DEBIT          | Inverso do crédito original; saldo não negativo protegido pela Wallet/coordenador                            |
| BET/WIN/REFUND/ROLLBACK zero              | REJECTED       | Aplicação resolve a política ZERO_AMOUNT, sem mudança financeira                                             |
| REJECTED / FAILED / PROCESSED             | Sem novo plano | Terminalidade impede avaliação/transição para repetir efeito                                                 |

Referências são conferidas em três níveis:

1. **Local:** exigência de ID externo em reversões, texto válido e ausência de autocitação. Referência interna persistida não pode ser o próprio UUID, inclusive com caixa diferente.
2. **Contra entidade encontrada:** ID externo solicitado, provider, player, wallet, moeda e round iguais; gameId não é restrição adicional. REFUND somente BET; ROLLBACK somente BET/WIN/REFUND, nunca LOSS/ROLLBACK/OPENING. Igualdade monetária exata para reversões, sem conversão por number. WIN somente referencia BET; não exige valores iguais nem ausência de reversões da BET. Referência entregue sem ter sido solicitada é incompatível.
3. **Global:** aplicação fornece histórico completo e atual sob o lock da wallet. Mesma modalidade é `InvalidWagerReversalError`; outra modalidade exige a política aprovada. Histórico omitido/inválido não equivale a lista vazia. O domínio não busca o banco nem marca a entidade original como revertida. Coordenação SQL e índices protegem os snapshots concorrentes.

Nenhuma transição de domínio aplica Wallet, cria ledger ou publica eventos. ProcessWagerUseCase obtém Wallet e referência/histórico sob coordenação SQL, avalia, aplica a consequência pela Wallet e associa BalanceChange ao ledger. Desde a Task 07, persiste também os eventos de [Messaging](messaging.md#task-07--protocolo-v1-implementado) na mesma transação antes de concluir o resultado idempotente. Domínio permanece independente da Outbox.

## Compatibilidade com persistência

Conferidos [migration inicial preservada](../../src/platform/persistence/migrations/Migration202610280001.ts), [portas evoluídas](../../src/modules/wagering/public/persistence.ts), [adapter](../../src/modules/wagering/adapters/persistence/mikro-orm-wager-transaction.repository.ts) e [Financial público preservado](../../src/modules/financial/public/index.ts).

- IDs, tipos externos, cinco estados, Money decimal e referências cabem em `wager_transactions`. Modelo técnico admite OPENING e nulos de contexto que a entidade externa não aceita. Reidratação é mais restritiva que o SQL sobre coerência de datas/failureCode/identidade; dados legados precisam ser conferidos antes de um mapper.
- `ProcessedWagerRecord` usa `null` para referências; a entidade usa `undefined`. O [mapper](../../src/modules/wagering/adapters/persistence/mappers.ts) converte explicitamente, exclui OPENING e reidrata todos os estados. `insert` persiste entidades; `save` altera somente não terminais; buscas por ID/identidade e histórico de reversões estão implementadas.
- `attempts`, `next_attempt_at`, `last_attempt_at`, `last_error` e `updated_at` são metadados técnicos de aquisição, retry e persistência, fora da entidade. A política de tentativas/TTL não foi antecipada. Não há classe espelhando toda a tabela.
- UNIQUE `(provider_id, external_transaction_id)`, índices parciais por modalidade e por referência e UNIQUE(scope,key) reforçam a coordenação. A [migration adicional](../../src/platform/persistence/migrations/Migration202610280002.ts) preserva o histórico anterior.
- SQL admite zero estrutural; aplicação rejeita zero financeiro e Financial exige ledger positivo. Sem movimentação fictícia.
- Saldo histórico/replay fica em `idempotency_records.original_result`, não em WagerTransaction. O [adapter idempotente](../../src/modules/wagering/adapters/persistence/mikro-orm-idempotency.repository.ts) reserva, lê sob lock e conclui o resultado na mesma sessão SQL.

## Validação unitária e alcance

[test/wager-transaction.test.ts](../../test/wager-transaction.test.ts) executa com `bun test test/wager-transaction.test.ts`, sem banco, Docker ou rede. Protege criação/reidratação/encapsulamento, cinco operações, todas as transições expostas, terminais, falha sem mutação parcial, referências/contextos/valores incompatíveis, zero, ausência versus estado encontrado, reversões repetidas e pendência de modalidade cruzada.

Essa suíte isolada não comprova garantias distribuídas. A Task 06 acrescenta [testes do caso de uso](../../test/process-wager.test.ts), [portas SQL](../../test/wagering-persistence.test.ts) e [processamento real multi-processo](../../test/process-wager-persistence.test.ts). Evidências financeiras ficam em [persistência](../persistence.md#task-06--processamento-atômico), e eventos/crash estão no [relatório da Task 07](../task07-outbox-report.md). Publicação/ACK/recuperação de workers continuam futuros.

Histórico do checkpoint anterior, núcleo Wagering (2026-10-28, Windows/PowerShell, Bun 1.4.4):

| Comando                                   | Resultado                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `bun test test/wager-transaction.test.ts` | 55 passaram, 0 falharam, 289 asserções; execução independente do revisor também passou                                     |
| `bun run typecheck`                       | Passou                                                                                                                     |
| `bun run lint`                            | Passou, incluindo arquitetura: 38 módulos, 90 dependências, nenhuma violação                                               |
| `bun run format:check`                    | Passou                                                                                                                     |
| `bun run test`                            | 179 passaram, 0 falharam, 1130 asserções em 9 arquivos, incluindo integrações existentes e testes negativos de arquitetura |
| `bun run build`                           | Passou                                                                                                                     |
| Documentação                              | Links relativos resolvidos e `git diff --check` aprovado; enunciado sem alterações                                         |

O checkout exigiu `bun install --frozen-lockfile`; lockfile e versões foram preservados. A primeira suíte completa falhou no setup de API/persistência porque Docker Engine estava desligado; após iniciar Docker Desktop, a execução acima passou. Ajustes de callbacks dos novos testes resolveram o lint sem alterar configurações. Revisão independente não encontrou defeitos bloqueantes.

No checkpoint anterior, consultas Graphify inicial e reformulada (`ProcessedWagerRecord`), geração e atualização falharam por ausência do executável; o índice não foi anunciado como atualizado. A busca restrita conferiu os contratos, adapters e migration citados. A [recuperação posterior do tooling](../tooling/graphify.md#recuperação-verificada--2026-10-28) foi autorizada e validada separadamente; não altera aquelas evidências históricas.

## Idempotência e replay (§§5, 6.3, 7, 9–10)

HTTP exige header Idempotency-Key como fonte da verdade; `"{providerId}:{externalTransactionId}"` é default **recomendado**, sem dispensar header. SQS fornece data.idempotencyKey. Idempotência é persistente e segura sob duplicatas concorrentes, independentemente da Inbox de [Messaging](messaging.md).

Canonicalização, algoritmo, campos, escopo e armazenamento estão definidos no contrato da Task 06 acima e implementados em [canonical-wager.ts](../../src/modules/wagering/application/canonical-wager.ts).

Repetição idêntica devolve **resultado original**, inclusive saldo histórico quando PROCESSED; resposta marca idempotentReplay true. Rejeições e pendências também têm replay sem efeitos. Evolução futura de resultados pendentes segue o contrato acima, preservando terminalidade e resultado processado original.

## Limitações e próximas etapas

- Worker de referências, aquisição de operações persistidas pendentes, atualização condicionada de seu resultado, backoff/TTL e esgotamento não estão implementados.
- Eventos e inserção Outbox estão implementados pela Task 07; HTTP pela Task 08. Inbox, publicação, SQS, ACK/DLQ e observabilidade completa de transporte permanecem futuros.
- FAILED permanece suportado pelo domínio/persistência; nenhuma falha técnica é classificada automaticamente como permanente nesta etapa.

Requisitos de eventos estão em [Messaging](messaging.md); status, validação runtime, header e exemplos estão em [HTTP](../http-api.md). HTTP retorna 200 PROCESSED, 202 PENDING/PENDING_REFERENCE e 422 REJECTED, preservando resultado/failureCode/replay. QueryWagerUseCase consulta identidades interna/externa e enumera DTOs sem key/hash/ORM; OPENING não é transação externa consultável. Limites de retry permanecem futuros. A garantia entregue é processamento financeiro efetivamente único por identidade/idempotência, sobre transporte at-least-once, sem promessa de exactly-once delivery.
