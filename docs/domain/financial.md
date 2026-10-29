# Financial: contratos e invariantes

Requisitos **explícitos** derivados dos §§5, 6.0–6.4, 7–9 e 13 de [challenge.md](../challenge.md), que permanece primário e imutável. Estrutura e fronteiras aprovadas estão em [ARCHITECTURE.md](../../ARCHITECTURE.md). Money, Wallet, WalletLedgerEntry e sua integração transacional PostgreSQL estão implementados e participam de ProcessWagerUseCase. A Task 08 entrega CreateWalletUseCase, QueryWalletUseCase, ReconcileWalletUseCase e seus [endpoints HTTP](../http-api.md).

## Modelagem e Money (§§6.0–6.1)

Estado encapsulado; construtores privados/protegidos, factories estáticas e rehydrate para reconstruir persistido sem revalidar transições. Nomes/assinaturas do esqueleto podem ser adaptados preservando garantias.

Money é imutável, com valor exato e moeda ISO-4217. Cada operação retorna nova instância. Contratos recebem e serializam `{ amount: string, currency: string }`, com decimal em escala fixa de **duas casas**. Não usar number, float ou double para dinheiro (§5).

O comportamento de referência cobre construção, zero por moeda, soma, subtração, negação, comparações de zero/sinal/ordem/igualdade e serialização. Aritmética entre moedas diferentes lança erro de domínio. Rejeitar NaN, Infinity, notação científica, string vazia, mais de duas casas e negativos nos contratos de entrada; representação interna pode expressar valores negativos necessários à aritmética, sem permitir saldo negativo.

Domínio não importa tipos monetários do ORM nem decorators NestJS. Persistência pode separar valor/moeda se for exata e reidratada como Money. A tarefa Financial Domain Core autoriza unidades mínimas em `bigint`, sem biblioteca decimal ou teto comercial. A [fundação de persistência](../persistence.md) usa strings/NUMERIC com escala 2. O §13 exige testes de arredondamento, mas não define modo nem autoriza arredondar entradas com escala inválida: casas excedentes são rejeitadas.

A entrada exige exatamente duas casas, sem sinal, espaços, separadores de milhar ou expoentes; zeros à esquerda são normalizados na saída. `Money.rehydrate` aceita sinal negativo para reconstruir resultados aritméticos serializados; não substitui `create` na validação de entradas externas. Zero negativo reconstruído é normalizado para `0.00`. Moedas usam catálogo local da [ISO-4217 List One da SIX](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml), publicação de 2026-09-17, sem consulta de rede em execução. A escala do desafio permanece 2 inclusive para códigos cujo minor unit ISO seja diferente; não há câmbio nem arredondamento por moeda. Atualizações do catálogo precisam de revisão explícita.

## Wallet (§6.2)

| Garantia explícita                                       | Evidência necessária                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| No máximo uma wallet por playerId + currency             | Unicidade no schema e conflito na criação duplicada (§§5, 9)         |
| Saldo nunca negativo                                     | Invariante encapsulada e garantia no PostgreSQL                      |
| Moeda da operação igual à wallet                         | Rejeição de conflito de moeda                                        |
| Toda mudança de saldo corresponde ao ledger e vice-versa | Atomicidade e reconstrução exata                                     |
| Nenhum lost update                                       | Concorrência real por wallet, incluindo três ou mais instâncias (§8) |
| version começa em 1 e incrementa somente se saldo muda   | LOSS, rejeição e replay sem mudança de versão                        |

Wallet mantém identidade, playerId, currency, balance, version, createdAt e updatedAt conforme o modelo de referência. Débito/crédito preservam encapsulamento e descrevem a mudança para o ledger. A persistência usa lock pessimista por registro e comparação adicional da versão na atualização, conforme [persistência](../persistence.md#integração-financeira-e-unitofwork). A associação e gravação do ledger continuam responsabilidade do coordenador.

`Wallet.create({ id, playerId, currency, createdAt })` cria exclusivamente saldo zero e versão 1. `rehydrate(WalletState)` valida estrutura, moeda/saldo, UUID interno, playerId não vazio, versão inteira positiva compatível com INTEGER SQL e datas válidas/ordenadas; preserva o estado sem aplicar crédito. Os métodos recebem `Money` não negativo e data explícita, válida e não anterior ao estado atual. Toda validação antecede mutação; overflow da versão SQL também falha sem efeitos.

`credit(amount, at)` e `debit(amount, at)` retornam `BalanceChange | undefined`. A mudança é imutável e contém `walletId`, `direction`, `amount`, `balanceBefore` e `balanceAfter`; não contém tipo de aposta nem requer Wagering. Valor zero retorna `undefined`, sem versão/data novas ou lançamento. Aceitação de zero por tipo de aposta pertence à política aprovada em [Wagering](wagering.md), sem alterar essa primitiva. Datas retornadas são cópias, e identidade/saldo/versão não têm setters públicos.

## Ledger e movimentações (§§5, 6.4, 7)

Ledger append-only, sem atualização/exclusão, sem campos mutáveis ou métodos de transição. Factory valida `balanceBefore ± money == balanceAfter`. Imutabilidade é estrutural e também garantida no schema. Identifica id, walletId, transactionId, direção DEBIT/CREDIT, Money, saldo anterior/posterior e createdAt.

`WalletLedgerEntry.create` recebe a mudança mais `id`, `transactionId` e `createdAt`. Tanto criação quanto reidratação validam identidades UUID, data, direção, três moedas iguais, saldos não negativos e aritmética exata; valor precisa ser positivo para representar mudança real. Reidratar valida o registro sem reaplicar operação. Objetos são congelados em execução, Money é imutável e datas são copiadas. Unicidade global continua exclusivamente no PostgreSQL.

Há no máximo um lançamento por transação financeira/wallet. LOSS e qualquer transação REJECTED não geram lançamento. Direção, valor e requisitos de cada operação pertencem à tabela de [Wagering](wagering.md), sem duplicar aqui as regras de reversão. Partidas dobradas são opcionais.

A aplicação financeira usa a transação recebida do orquestrador; não abre commit independente. Fronteira atômica e responsabilidade do commit pertencem à [Arquitetura](../../ARCHITECTURE.md). Persistência deve proteger unicidade, imutabilidade e não-negatividade, sem apenas confiar na aplicação.

## Abertura (§9)

`POST /wallets` recebe playerId e initialBalance MoneyProps. Abertura é um caso de uso próprio. Saldo inicial **maior que zero** exige transação interna OPENING e lançamento CREDIT junto à wallet na mesma transação SQL. A resposta inclui id/playerId/balance/version, com version **1**, inclusive após o crédito inicial.

Zero é permitido como saldo inicial: a condição de gerar OPENING é saldo positivo. Não criar lançamento fictício para abertura zero. Criação duplicada de playerId/moeda falha como conflito. OPENING não é entrada externa; a porta pública `OpeningTransactionRepository` e seu adapter Financial gravam o registro interno no armazenamento compartilhado sem importar Wagering.

`Wallet.create` permanece exclusivamente a zero. A [proposta de evolução](../financial-persistence-proposal.md), registrada antes da implementação conforme §10 da tarefa de integração, adiciona `Wallet.open(OpenWalletProps)`: recebe `initialBalance: Money` junto aos campos de criação, valida as mesmas invariantes estruturais e inicia saldo/versão/datas sem aplicar crédito comum. Negativo ou moeda incompatível falham. `rehydrate` continua exclusivamente reconstruindo estado; mappers não o usam para simular abertura.

CreateWalletUseCase persiste wallet → OPENING → ledger CREDIT numa única execução de `UnitOfWork`, inclusive com saldo positivo e versão 1. A factory não persiste nada; a obrigação de registrar OPENING/ledger é do coordenador. Não há evento Wagering de abertura. A constraint player/moeda protege concorrência, sem mutex global; o filtro HTTP traduz somente a violação dessa constraint para 409, preservando o erro SQL original dos adapters. [Testes dos adapters](../../test/financial-persistence.test.ts) e [HTTP real](../../test/http-api.test.ts) demonstram abertura positiva atômica, rollback integral em OPENING/ledger e abertura zero sem registro fictício.

## Reconciliação (§§9, 13)

Reconstruir saldo pelo ledger, incluindo crédito de abertura quando existente, e comparar com materializado. `POST /wallets/:walletId/reconciliation` retorna walletId, storedBalance, calculatedBalance, difference (MoneyProps), consistent e checkedEntries.

ReconcileWalletUseCase usa Money exato e `difference = storedBalance - calculatedBalance`, preservando o sinal. Wallet e histórico inteiro compartilham uma transação REPEATABLE READ READ ONLY, sem locks exclusivos. Reconstrói desde zero por direção/valor, incluindo OPENING e reversões; não confia no último balanceAfter. Confere a continuidade dos saldos por grupos de timestamp; em empates exige uma cadeia conectada possível, sem ordenar financeiramente por UUID. Cada lançamento passa pelas validações de aritmética do domínio. Incoerência histórica pode produzir consistent false com diferença zero.

Divergências aparecem na resposta, log JSON seguro e contador por instância, sem autocorreção, compensação fictícia ou escrita de qualquer espécie. O contador não é agregado/durável nem exportado para backend de métricas nesta etapa. Remediação financeira continua fora do escopo. A igualdade entre saldo materializado e reconstruído é a invariante final dos testes financeiros. [Testes de concorrência HTTP](../../test/http-concurrency.test.ts) confirmam um commit entre leitura de wallet e ledger, mantendo o snapshot anterior consistente.

QueryWalletUseCase retorna DTO de wallet e ledger paginado por `(created_at,id)`. A âncora do cursor é a linha imutável no PostgreSQL, sem truncar microssegundos; default 50, intervalo 1–100. Contratos, respostas e limites estão em [HTTP](../http-api.md).

## Pendências e limites

Portas, adapters, mappers e UnitOfWork estão descritos em [persistência](../persistence.md#integração-financeira-e-unitofwork). ProcessWagerUseCase associa `BalanceChange` à transação e persiste saldo/versão/ledger e eventos Outbox atomicamente; o retorno isolado da primitiva não prova commit nem deduplicação. Escala fixa não define limites máximos, taxas, câmbio ou arredondamento comercial. Emissão de eventos pertence a [Messaging](messaging.md#task-07--protocolo-v1-implementado), sem dependência Financial → Wagering; políticas por operação pertencem a [Wagering](wagering.md).

## API entregue e evidências (§§6.0–6.4, 13)

Entrada pública do módulo: [public/index.ts](../../src/modules/financial/public/index.ts), sem infraestrutura.

| Componente        | API pública                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Money             | `create`, `rehydrate`, `zero`, `add`, `subtract`, `negate`, `equals`, `compare`, `isZero`, `isPositive`, `isNegative`, `toProps`, `currency` |
| Wallet            | `create`, `open`, `rehydrate`, `credit`, `debit`; leitura de id/playerId/currency/balance/version/createdAt/updatedAt                        |
| WalletLedgerEntry | `create`, `rehydrate`; leitura de id/walletId/transactionId/direction/amount/balanceBefore/balanceAfter/createdAt                            |

Erros distinguíveis: `InvalidMoneyError`, `CurrencyMismatchError`, `InsufficientBalanceError`, `InvalidWalletStateError` e `InconsistentLedgerEntryError`, sem HTTP/failureCode. `compare` retorna -1/0/1; `equals` também rejeita moeda incompatível.

Testes sem PostgreSQL/Nest/Docker: [Money](../../test/money.test.ts), [Wallet](../../test/wallet.test.ts) e [Ledger](../../test/wallet-ledger-entry.test.ts). Cobrem precisão acima de 53 bits, escala inválida sem arredondar, inversas aritméticas, falhas sem mutação, abertura versão 1, reconstrução sequencial do saldo por lançamentos, datas defensivas e imutabilidade em execução. A [compatibilidade com ExactNumericType](../../test/persistence-config.test.ts) é verificada separadamente; a integração e os mappers são exercitados com [PostgreSQL real](../../test/financial-persistence.test.ts).
