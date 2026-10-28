# Financial: contratos e invariantes

Requisitos **explícitos** derivados dos §§5, 6.0–6.4, 7–9 e 13 de [challenge.md](../challenge.md), que permanece primário e imutável. Estrutura e fronteiras aprovadas estão em [ARCHITECTURE.md](../../ARCHITECTURE.md); não há implementação financeira ainda.

## Modelagem e Money (§§6.0–6.1)

Estado encapsulado; construtores privados/protegidos, factories estáticas e rehydrate para reconstruir persistido sem revalidar transições. Nomes/assinaturas do esqueleto podem ser adaptados preservando garantias.

Money é imutável, com valor exato e moeda ISO-4217. Cada operação retorna nova instância. Contratos recebem e serializam `{ amount: string, currency: string }`, com decimal em escala fixa de **duas casas**. Não usar number, float ou double para dinheiro (§5).

O comportamento de referência cobre construção, zero por moeda, soma, subtração, negação, comparações de zero/sinal/ordem/igualdade e serialização. Aritmética entre moedas diferentes lança erro de domínio. Rejeitar NaN, Infinity, notação científica, string vazia, mais de duas casas e negativos nos contratos de entrada; representação interna pode expressar valores negativos necessários à aritmética, sem permitir saldo negativo.

Domínio não importa tipos monetários do ORM nem decorators NestJS. Persistência pode separar valor/moeda se for exata e reidratada como Money. O desafio permite operar só BRL, desde que modelo permaneça multimoeda e conflitos sejam testados; adotar essa redução ainda é uma escolha, não um requisito. Biblioteca e representação interna continuam pendentes; a [fundação de persistência](../persistence.md) usa strings/NUMERIC com escala 2, sem definir teto comercial. O §13 exige testes de arredondamento, mas não define modo nem autoriza arredondar entradas com escala inválida.

## Wallet (§6.2)

| Garantia explícita                                       | Evidência necessária                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| No máximo uma wallet por playerId + currency             | Unicidade no schema e conflito na criação duplicada (§§5, 9)         |
| Saldo nunca negativo                                     | Invariante encapsulada e garantia no PostgreSQL                      |
| Moeda da operação igual à wallet                         | Rejeição de conflito de moeda                                        |
| Toda mudança de saldo corresponde ao ledger e vice-versa | Atomicidade e reconstrução exata                                     |
| Nenhum lost update                                       | Concorrência real por wallet, incluindo três ou mais instâncias (§8) |
| version começa em 1 e incrementa somente se saldo muda   | LOSS, rejeição e replay sem mudança de versão                        |

Wallet mantém identidade, playerId, currency, balance, version, createdAt e updatedAt conforme o modelo de referência. Débito/crédito devem preservar encapsulamento e correspondência com ledger. Version é sugerido para optimistic locking; a estratégia ainda está pendente. Não presumir update sem controle ou lock em memória suficiente.

## Ledger e movimentações (§§5, 6.4, 7)

Ledger append-only, sem atualização/exclusão, sem campos mutáveis ou métodos de transição. Factory valida `balanceBefore ± money == balanceAfter`. Imutabilidade é estrutural e também garantida no schema. Identifica id, walletId, transactionId, direção DEBIT/CREDIT, Money, saldo anterior/posterior e createdAt.

Há no máximo um lançamento por transação financeira/wallet. LOSS e qualquer transação REJECTED não geram lançamento. Direção, valor e requisitos de cada operação pertencem à tabela de [Wagering](wagering.md), sem duplicar aqui as regras de reversão. Partidas dobradas são opcionais.

A aplicação financeira usa a transação recebida do orquestrador; não abre commit independente. Fronteira atômica e responsabilidade do commit pertencem à [Arquitetura](../../ARCHITECTURE.md). Persistência deve proteger unicidade, imutabilidade e não-negatividade, sem apenas confiar na aplicação.

## Abertura (§9)

`POST /wallets` recebe playerId e initialBalance MoneyProps. Abertura é um caso de uso próprio. Saldo inicial **maior que zero** exige transação interna OPENING e lançamento CREDIT junto à wallet na mesma transação SQL. A resposta inclui id/playerId/balance/version, com version **1**, inclusive após o crédito inicial.

Zero é permitido como saldo inicial: a condição de gerar OPENING é saldo positivo. Não criar lançamento fictício para abertura zero. Criação duplicada de playerId/moeda falha como conflito. OPENING não é entrada externa; o mecanismo de registro entre módulos ainda precisa ser definido sem Financial importar Wagering.

## Reconciliação (§§9, 13)

Reconstruir saldo pelo ledger, incluindo crédito de abertura quando existente, e comparar com materializado. `POST /wallets/:walletId/reconciliation` retorna walletId, storedBalance, calculatedBalance, difference (MoneyProps), consistent e checkedEntries.

Divergências devem aparecer na resposta, logs e métrica; não corrigir silenciosamente. Sinal da diferença, snapshot consistente sob concorrência e procedimentos de remediação não foram definidos. Não inventar política de ajuste financeiro. A igualdade entre saldo materializado e reconstruído é a invariante final dos testes financeiros.

## Pendências e limites

Representação monetária do domínio, estratégia de locks e interfaces transacionais continuam pendentes em [Arquitetura](../../ARCHITECTURE.md); ORM e representação persistida foram definidos na fundação. Escala fixa não define limites máximos, regras de taxas, câmbio ou arredondamento comercial. Efeitos de operações de valor zero e sua relação com ledger/eventos precisam de esclarecimento em [Wagering](wagering.md), sem impor uma regra adicional.
