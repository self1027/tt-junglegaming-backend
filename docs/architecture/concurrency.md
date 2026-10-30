# Concorrência e coordenação

A unidade financeira é walletId. O banco serializa decisões sobre a mesma wallet;
wallets distintas podem confirmar em paralelo. FIFO, mutex local e ordem de
chegada não sustentam essa garantia. [Cenários verificáveis](../testing/distributed-scenarios.md).

## Coordenação do processamento

Ordem dos recursos no [ProcessWagerUseCase](../../src/modules/wagering/application/process-wager.use-case.ts):

1. SQS adquire Inbox; HTTP começa diretamente na idempotência.
2. Reserva (scope,key) por INSERT ON CONFLICT. Duplicata espera o concorrente;
   leitura sob lock compara hash e retorna snapshot ou conflito.
3. Advisory transaction lock da identidade externa (provider,external).
4. Resolução player/moeda e SELECT FOR UPDATE da wallet, com refresh.
5. Leitura da referência e do histórico de reversões; avaliação e escritas.
6. Conclusão de resultado/Inbox e commit ou rollback, liberando recursos.

O [lock de identidade](../../src/modules/wagering/adapters/persistence/mikro-orm-wager-transaction.repository.ts)
usa hash PostgreSQL de tupla JSON com namespace. Não é global; colisão de hash
aumenta contenção, sem remover unicidade. UNIQUE(provider,external) reforça a
identidade. Outra key da mesma identidade conflita sem criar nova operação.

READ COMMITTED e refresh observam o estado confirmado depois da espera. O
[save de wallet](../../src/modules/financial/adapters/persistence/mikro-orm-wallet.repository.ts)
condiciona escrita à versão lida e exige a instância adquirida sob lock nessa
execução. Alteração financeira incrementa versão; LOSS, rejeição e replay não.
FOR UPDATE fica até commit/rollback. Hot wallet tem serialização inevitável;
nenhum lock global impede as demais wallets.

Reversões também reavaliam a neutralização do REFUND depois de adquirir wallet.
Se outro processo confirma ROLLBACK de REFUND durante a espera, a nova modalidade
observa esse fato confirmado antes de decidir. Não se bloqueiam várias linhas de
reversão em ordem variável. A migration 290004 adquire a mesma wallet na proteção
SQL e lê novamente o histórico; no caminho da aplicação esse lock já pertence à
UnitOfWork. Escritores SQL diretos devem respeitar essa mesma ordem. Unicidade por
modalidade permanece um índice, sem mutex global ou transação financeira adicional.

Referências elegíveis compartilham a wallet. Não se adquire outra identidade
externa, key ou wallet para consultar referência. Contexto incompatível é
rejeitado. Original confirma antes da leitura da reversão, ou a reversão observa
ausência/pendência durável. Isso evita inversão entre linhas de original e
reversão. Se um fluxo futuro exigir múltiplas wallets, deve adquiri-las em ordem
crescente de UUID canônico; não há esse fluxo entregue.

## Worker e publisher

Claim é confirmado antes da execução financeira/rede, por FOR UPDATE SKIP LOCKED.
Seleção não espera uma linha já bloqueada. O worker então usa a ordem
idempotência existente, identidade externa, wallet, linha/claim, referência.
Não mantém lock do claim enquanto espera wallet. O publisher disputa somente
Outbox e não participa dos locks financeiros.

Novo claim recebe token novo, mesmo com o mesmo owner. Expiração é decidida pelo
banco. Finalização por token/estado/lease válido impede atualização pelo dono
antigo. No worker, essa guarda é o último UPDATE dentro do commit financeiro;
falha reverte todos os efeitos. No publisher, protege a marcação SQL; a rede já
pode ter aceitado o evento. [Detalhes SQL](../persistence.md#claims-e-fencing).

## Falhas e isolamento de leitura

HTTP/SQS não fazem retry SQL dentro do use case. Deadlock, timeout e falhas de
conexão propagam rollback; HTTP distingue falha transitória, SQS redelivera, worker
agenda tentativa após retorno da UnitOfWork. Nenhum erro técnico se transforma
silenciosamente em rejeição financeira. Lease expirado e perda de visibilidade
não provam ausência de commit: a recuperação consulta o estado durável.

Consultas/reconciliação usam REPEATABLE READ READ ONLY, com wallet e ledger no
mesmo snapshot e sem FOR UPDATE. Isso impede misturar saldo de um instante com
ledger posterior. Cada página de ledger tem snapshot próprio; várias páginas
não são uma leitura global congelada. [Financial](../domain/financial.md#reconciliação).

## Evidência e limites

[Três APIs](../../test/http-concurrency.test.ts),
[três pools do processador](../../test/process-wager-persistence.test.ts),
[três consumers](../../test/sqs-consumer.test.ts) e
[workers concorrentes](../../test/pending-distributed.test.ts) usam processos
independentes, barreiras e observação SQL de espera. Testes de publisher verificam
SKIP LOCKED, envio sem transação e finalização obsoleta.

São provas dos cenários executados, sem promessa de ausência universal de deadlock
para clientes que ignorem a ordem. Constraints protegem unicidade/imutabilidade/
não-negatividade; clientes SQL arbitrários ainda podem quebrar relações mantidas
pelo coordenador. O [benchmark local](../testing/load-test.md) compara wallets
independentes e hot wallet, sem meta de RPS.
