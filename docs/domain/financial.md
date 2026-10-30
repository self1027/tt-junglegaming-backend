# Financial: Money, Wallet e ledger

[Money](../../src/modules/financial/domain/money.ts),
[Wallet](../../src/modules/financial/domain/wallet.ts) e
[WalletLedgerEntry](../../src/modules/financial/domain/wallet-ledger-entry.ts)
implementam os §§5, 6.0 a 6.4 e 9 do [enunciado](../challenge.md).
O domínio não importa NestJS, ORM ou Wagering. Construtores são privados;
factories criam ou reidratam estado sem reaplicar transições.

## Money

Money guarda unidades de 1/100 em `bigint`. Soma/subtração/negação são exatas,
inclusive acima de 53 bits; nenhuma etapa converte dinheiro para number, float
ou double. Decimal binário perderia precisão em valores e centavos. A saída é
`MoneyProps { amount: string, currency: string }`, sempre com duas casas.

`create` aceita decimal não negativo com exatamente duas casas. Rejeita número,
NaN, Infinity, expoentes, espaços, sinais, string vazia, separador de milhar e
escala excedente. Zeros à esquerda são normalizados na saída. `rehydrate` admite
sinal negativo para reconstruir resultados aritméticos; zero negativo vira 0.00.
Não é a factory de entrada externa. Entradas de escala inválida são rejeitadas,
sem arredondamento implícito.

Moedas usam [catálogo local ISO-4217](../../src/modules/financial/domain/currencies.ts),
com origem/data registradas no código; não há consulta de rede em execução ou
dependência de locale. A escala do desafio é 2 inclusive para códigos com minor
unit ISO diferente. Não há câmbio, taxa ou arredondamento comercial. O modelo é
multi-moeda; operações binárias entre moedas diferentes lançam CurrencyMismatchError,
inclusive equals. O catálogo só muda por revisão explícita.

Money é congelado e imutável. API: create, rehydrate, zero, add, subtract, negate,
equals, compare (-1/0/1), isZero/isPositive/isNegative e toProps. A persistência
usa [strings e NUMERIC](../persistence.md#representação-e-schema); resultados
negativos internos não são aceitos nas colunas não negativas de saldo/movimento.

## Wallet

Uma wallet pertence a player/moeda, com identidade UUID, saldo, version e datas.
`create` inicia zero, versão 1; `open` recebe initialBalance e também inicia
versão 1. Ambas validam estado. `rehydrate` confere estrutura, saldo não negativo,
moeda, UUID, texto de player, versão INTEGER positiva e datas válidas/ordenadas,
sem aplicar crédito ou transição histórica.

Credit/debit recebem Money não negativo da mesma moeda e data não anterior a
updatedAt. Toda validação acontece antes de mutação. Débito sem saldo falha;
versão máxima SQL (2147483647) impede novo movimento sem alterar estado.
Zero retorna undefined e preserva saldo, versão e updatedAt. Movimento positivo
retorna BalanceChange imutável com walletId, direção, amount, balanceBefore e
balanceAfter; incrementa version uma vez e atualiza a data.

Identidade não tem setters; saldo/versão ficam privados; Date é copiada na entrada
e na saída. A factory sozinha não garante unicidade global ou commit. O
[adapter](../../src/modules/financial/adapters/persistence/mikro-orm-wallet.repository.ts)
exige a instância obtida por lockById naquela transação, mantém FOR UPDATE e
condiciona a escrita à versão lida. Sem mudança de versão não escreve. Unicidade
player/moeda e não-negatividade também são protegidas pelo PostgreSQL.
[Concorrência por wallet](../architecture/concurrency.md).

## Ledger

WalletLedgerEntry é estruturalmente imutável, sem métodos de transição. `create`
recebe BalanceChange, id, transactionId e createdAt; valida UUIDs, direção, data,
moedas iguais, amount positivo, saldos não negativos e a equação exata
`balanceBefore ± amount = balanceAfter`. Reidratar valida o registro sem aplicar
movimento. Money e objetos são congelados; datas são defensivas.

O coordenador associa cada BalanceChange à transação financeira e persiste
saldo/versão/ledger no mesmo commit. Há no máximo um lançamento por transação/wallet.
LOSS e operações rejeitadas não têm lançamento. As direções por operação pertencem
a [Wagering](wagering.md#operações). O banco reforça unicidade, FKs, aritmética,
finitude, escala e append-only, incluindo UPDATE/DELETE/TRUNCATE diretos.

O ledger usa uma entrada por movimento; não é contabilidade de partidas dobradas.
Saldo materializado versus soma do ledger depende da unidade transacional e dos
adapters: o schema não reconcilia automaticamente escritas SQL arbitrárias.

## Abertura

[CreateWalletUseCase](../../src/modules/financial/application/create-wallet.use-case.ts)
persiste wallet, OPENING e CREDIT no mesmo execute quando initialBalance > 0.
OPENING é escrito por uma porta Financial na tabela técnica compartilhada, sem
importar Wagering. Abertura mantém version 1 e não emite evento Wagering. Inicial
zero cria apenas a wallet, sem registro fictício. Duplicata player/moeda é conflito
pela constraint específica, inclusive entre instâncias.

`Wallet.open` inicia estado e não persiste nada. A obrigação de OPENING/ledger é
do caso de uso; usar credit comum mudaria a versão e não representa a abertura.
A [proposta anterior](../history/plans/financial-persistence-proposal.md) permanece
como histórico, sem substituir este contrato.

## Reconciliação

[ReconcileWalletUseCase](../../src/modules/financial/application/reconcile-wallet.use-case.ts)
lê wallet e todo o ledger na mesma transação REPEATABLE READ READ ONLY.
O snapshot é estabelecido na leitura da wallet e preservado ao ler ledger,
mesmo com commit concorrente. Não usa FOR UPDATE nem bloqueia escritores.

Reconstrói desde zero por direção/valor, incluindo OPENING; não confia no último
balanceAfter. Difference = storedBalance - calculatedBalance, preservando sinal.
Cada lançamento é validado pelo mapper/domínio. A continuidade é conferida por
grupos de timestamp em milissegundos: empates exigem uma cadeia conectada possível
de saldos, sem atribuir ordem financeira aos UUIDs. Histórico desconectado pode
produzir consistent false mesmo com diferença zero.

Divergência aparece na resposta, log e métrica, sem escrever saldo, ledger, versão
ou Outbox. [Diagnóstico](../operations/observability.md) não é remediação financeira.
O histórico inteiro é carregado em memória; volume muito grande exige evolução
para leitura incremental mantendo o mesmo snapshot. A reconciliação de testes
compara saldo materializado e reconstruído após os fluxos financeiros.

QueryWalletUseCase oferece wallet e ledger keyset por `(created_at,id)`, usando
âncora SQL imutável para preservar microssegundos. Páginas diferentes não formam
um snapshot único. Campos, cursor e respostas pertencem ao
[contrato HTTP](../contracts/http.md).

## Verificação

[Money](../../test/money.test.ts), [Wallet](../../test/wallet.test.ts) e
[Ledger](../../test/wallet-ledger-entry.test.ts) testam precisão, escala, moedas,
falha sem mutação e imutabilidade. [Adapters PostgreSQL](../../test/financial-persistence.test.ts)
verificam representação, abertura atômica, rollback, pools e três processos.
[HTTP](../../test/http-api.test.ts) e [snapshot concorrente](../../test/http-concurrency.test.ts)
verificam respostas e leitura consistente durante commit. Tipos/erros públicos
ficam no [public](../../src/modules/financial/public/index.ts).
