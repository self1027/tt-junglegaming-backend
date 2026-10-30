# Task 12.1: conformidade de RE-03

Data: 2026-10-29. RE-03: IMPLEMENTED conforme a política explicitamente aprovada.
Validação final: 487 testes passaram, zero falhas, 4.775 asserções em 38 arquivos.
As seções do checkpoint A registram a análise anterior à alteração; decisão,
implementação e evidências finais estão nas seções seguintes.

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.1, PostgreSQL 18.3 e
LocalStack 4.14.0 reais; imagens pinadas por digest no Compose. Sem novas
dependências ou alteração do lockfile.

## Git e preservação da Task 12

Foram executados status, branch atual/todas as branches, log dos cinco commits,
diff e diff cached antes de editar. A Task 12 estava no index e no working tree,
sem commits posteriores a a36e6a0, na branch feat/pending-reference-worker.

Foi criada fix/reversal-re03-conformance no mesmo HEAD, mantendo index e arquivos
existentes. A branch anterior não foi movida. Não houve commit, push, reset,
clean, rebase ou merge. Três patches de preservação foram gravados fora do
repositório em C:/Users/MuriloD/AppData/Local/Temp/dwp-task12-baseline-28f82ac3-c4fc-476d-bf32-24755ae1bb47:
estado final da Task 12, index e diferenças do working tree.

## Fonte e requisito literal

O [enunciado](../../challenge.md) é imutável. O §7, regra adicional 4, determina:
“Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.”
REFUND credita uma BET PROCESSED; ROLLBACK inverte BET, WIN ou REFUND PROCESSED.
O valor é integral e cada reversão processada tem lançamento correspondente.

A unicidade literal é por referência e modalidade. Isso não determina, sozinho,
se ambas as modalidades devem ser aceitas como compensações simultaneamente
ativas da BET. Também não define um PROCESSED sem movimento para esse caso.
A Task 12.1 exige adicionalmente impedir compensações cumulativas indevidas.

Fontes conferidas: contratos [Wagering](../../domain/wagering.md),
[Financial](../../domain/financial.md), [persistência](../../persistence.md),
[concorrência](../../architecture/concurrency.md),
[arquitetura](../../../ARCHITECTURE.md), [matriz](../../requirements.md),
[Task 11](task11-pending-report.md) e [Task 12](task12-audit-report.md).

## Dez respostas do checkpoint A

1. REFUND e ROLLBACK são modalidades diferentes; REFUND só referencia BET e
   ROLLBACK também pode referenciar WIN ou REFUND. Independência dos tipos não
   demonstra independência da compensação econômica da mesma BET.
2. A proibição expressa de duplicidade é pelo par referência/modalidade.
3. Ambas podem apontar para BET quanto à elegibilidade de tipo. A aceitação
   conjunta de duas compensações diretas não está explicitamente definida.
4. Ambas PROCESSED enquanto seus créditos permanecem ativos é um caso ambíguo.
   Ambas historicamente PROCESSED após neutralizar um REFUND é outra situação.
5. Se a segunda for processada segundo a tabela, seu movimento é integral.
   Processá-la sem ledger/movimento acrescentaria uma exceção ao contrato.
6. Não há prioridade expressa por ordem de chegada ou modalidade.
7. Duas reversões diretas creditam igualmente. As cadeias são assimétricas:
   ROLLBACK de REFUND é permitido; ROLLBACK de ROLLBACK não é.
8. A referência distingue as operações: ROLLBACK de BET credita; de REFUND ou
   WIN debita. Reverter REFUND não altera a BET nem seu registro terminal.
9. Concorrência deve equivaler a uma execução serial válida sob o lock da wallet,
   com histórico relido depois da espera. Nenhuma preferência de vencedor é
   exigida; idempotência não se confunde com conflito entre comandos distintos.
10. Combinações não especificadas exigem interpretação documentada. Não é
    correto transformar ausência de proibição em autorização de crédito novo,
    nem apresentar uma política adicional como texto literal.

## Interpretações e efeitos financeiros

Base exata: wallet 100.00, BET 80.00, saldo 20.00.

| Interpretação                                                    | Efeito e ledger                                                                                                                                | Limite                                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Cada modalidade direta credita integralmente                     | REFUND leva a 100.00; ROLLBACK da BET leva a 180.00; dois créditos distintos                                                                   | Segue as direções isoladamente, mas não resolve a intenção do anexo de impedir compensação cumulativa indevida. Não recomendada. |
| Segunda modalidade PROCESSED sem efeito                          | Saldo 100.00; segunda sem ledger e sem incremento de versão                                                                                    | Acrescenta exceção à tabela de movimentos; não recomendada.                                                                      |
| Uma reversão direta histórica para sempre                        | Saldo máximo 100.00; segunda modalidade sempre rejeitada                                                                                       | Política anterior: continua impedindo modalidade inédita mesmo depois de neutralizar o REFUND.                                   |
| Uma compensação direta ativa; unicidade histórica por modalidade | Segunda direta enquanto crédito anterior ativo é rejeitada. REFUND(BET) → ROLLBACK(REFUND) → ROLLBACK(BET) gera saldos 100.00 → 20.00 → 100.00 | Política recomendada, mas inferida: requer decisão sobre compensação ativa. Cada PROCESSED conserva movimento integral e ledger. |

A recomendação distingue duas regras: repetir modalidade permanece proibido
historicamente; mudar modalidade só pode compensar quando o crédito anterior
não está mais ativo. ROLLBACK de REFUND debita, não é nova compensação da BET.
Rejeições anteriores continuam terminais; uma operação distinta seria necessária
para tentar a modalidade inédita depois da neutralização.

## Matriz de comportamento antes/depois

F = REFUND; R = ROLLBACK. A coluna depois registra a política de compensação ativa
aprovada e implementada, verificada pelos testes relacionados ao final. Os
failureCodes existentes foram preservados. A última coluna distingue requisito
literal e interpretação adicional.

| Original / ordem e referências                   | Atual                      | Depois: estado, movimento, código                                                    | Origem da regra                                                             |
| ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| BET → F(BET), sem reversão anterior              | PROCESSED                  | PROCESSED, CREDIT integral                                                           | Exigido pelo §7                                                             |
| BET → R(BET), sem reversão anterior              | PROCESSED                  | PROCESSED, CREDIT integral                                                           | Exigido pelo §7                                                             |
| BET → F(BET) → outro F(BET)                      | REJECTED                   | REJECTED, sem movimento, DUPLICATE_REVERSAL                                          | Proibido expressamente pelo §7.4                                            |
| BET → R(BET) → outro R(BET)                      | REJECTED                   | Mesma rejeição de duplicidade                                                        | Proibido expressamente pelo §7.4                                            |
| BET → F(BET) → R(BET), F ativo                   | REJECTED cumulativa        | REJECTED, sem movimento, CUMULATIVE_REVERSAL_NOT_ALLOWED                             | Política inferida de compensação ativa; aceitação conjunta não especificada |
| BET → R(BET) → F(BET)                            | REJECTED cumulativa        | Mesma rejeição cumulativa                                                            | Política inferida; R não pode ser neutralizado por outro R                  |
| BET → F(BET) → R(F) → R(BET)                     | Última rejeitada           | Última PROCESSED, CREDIT integral; saldo final 100.00                                | Nova interpretação proposta; preserva unicidade por tipo                    |
| BET → F(BET) → R(F) → outro F(BET)               | REJECTED duplicata         | REJECTED, DUPLICATE_REVERSAL                                                         | Unicidade histórica por modalidade, §7.4                                    |
| REFUND PROCESSED → R(REFUND)                     | PROCESSED se saldo permite | DEBIT integral; REVERSAL_INSUFFICIENT_BALANCE se insuficiente                        | Exigido pelo §7 e regra 9                                                   |
| WIN PROCESSED → R(WIN)                           | PROCESSED se saldo permite | DEBIT integral; mesmo código distinto se insuficiente                                | Exigido pelo §7                                                             |
| WIN → F(WIN)                                     | REJECTED                   | REJECTED, INCOMPATIBLE_REFERENCE                                                     | Proibido pelo §7, regra 3                                                   |
| LOSS / ROLLBACK / OPENING → F ou R da original   | REJECTED                   | REJECTED, INCOMPATIBLE_REFERENCE                                                     | Tipos excluídos pelo contrato                                               |
| Referência ausente ou não terminal               | Pendente                   | Mesmo comportamento pendente, sem saldo/ledger; worker aplica a política ao resolver | Exigido pelo §7.1                                                           |
| Referência REJECTED/FAILED                       | REJECTED                   | REJECTED, REFERENCE_TERMINAL_INELIGIBLE                                              | Inferido da exigência de original PROCESSED                                 |
| Mesma identidade/key/payload em qualquer disputa | Replay                     | Resultado histórico; nenhum novo movimento, versão ou evento                         | Exigido pelos §§7.7 e 9                                                     |
| Mesma key com payload diferente                  | Conflito                   | Mesmo conflito, sem nova operação                                                    | Exigido pelo §9                                                             |
| Contexto/moeda/valor incompatível                | REJECTED                   | INCOMPATIBLE_REFERENCE, sem movimento                                                | Exigido pelo §7, regras 2 e 5                                               |

## Causa exata da divergência anterior

- [Domínio](../../../src/modules/wagering/domain/wager-transaction.ts):
  processingDecision valida histórico, rejeita modalidade repetida e retorna
  POLICY_REQUIRED/CROSS_TYPE_REVERSAL quando há outra modalidade processada.
- [Motor](../../../src/modules/wagering/application/process-wager.ts): converte
  essa decisão em CUMULATIVE_REVERSAL_NOT_ALLOWED, incondicionalmente.
- [Repository](../../../src/modules/wagering/adapters/persistence/mikro-orm-wager-transaction.repository.ts):
  retorna somente modalidades de reversões diretas PROCESSED. Não distingue
  REFUND ativo de REFUND neutralizado por ROLLBACK de REFUND.
- [Migration inicial](../../../src/platform/persistence/migrations/Migration202610280001.ts)
  já protege unicidade parcial por referência/modalidade.
- [Migration 280002](../../../src/platform/persistence/migrations/Migration202610280002.ts)
  acrescenta UNIQUE parcial somente por reference_transaction_id para reversões
  PROCESSED. Impede qualquer segunda modalidade, mesmo após neutralização.
- HTTP/SQS e resolver de pendências compartilham processWager. Logo a política
  não está duplicada em transportes; o worker recebe a mesma restrição.

Idempotência/identidade precedem o lock da wallet; referência/histórico são lidos
depois dele. UnitOfWork, repositórios Financial e finalização de pendência mantêm
saldo/ledger/estado/resultados/Outbox na mesma transação. Não há razão identificada
para alterar essa ordem ou criar outro caminho financeiro.

## Plano definido no checkpoint A

1. Confirmar qual interpretação vale para a compensação ativa. Não remover a
   proteção histórica nem anunciar conformidade antes dessa definição.
2. Se aprovada a proposta, testes primeiro para o caso novo após neutralização,
   ambas as ordens diretas e duplicidade histórica; preservar testes de segurança.
3. Ajustar somente os fatos de histórico necessários, decisão compartilhada e
   proteção SQL incremental. Manter o índice por modalidade e proteger a regra
   financeira aprovada. Down deve recusar dados incompatíveis sem editá-los.
4. Validar PostgreSQL real, precisão acima de 53 bits, falhas em todos os
   participantes, três processos, HTTP/SQS/worker, replay e crashes.
5. Revisar independentemente o diff final; atualizar apenas documentos
   proprietários e RE-03 com evidências executadas. Preservar relatórios antigos.
6. Executar typecheck, lint/arquitetura, format:check, suíte completa, build,
   smoke Docker, documentação, Graphify e git diff --check.

## Revisão e evidências até este checkpoint

Revisor independente, somente leitura, confirmou a ambiguidade e criticou as
quatro interpretações. Recomendou distinguir compensação ativa de unicidade
histórica por modalidade, explicitando que isso é interpretação adicional.
Essa revisão de análise não substitui a revisão final de código/migration.

A baseline histórica da Task 12 é 458 testes, zero falhas, 4.150 asserções em
37 arquivos. Não é apresentada como teste reexecutado na Task 12.1.
Não houve alteração executável ou migration nova antes desse checkpoint.
Alterações da Task 12 permanecem preservadas separadamente pelos patches e pelo
estado do Git. Os resultados posteriores estão nas seções seguintes.

## Decisão financeira aprovada

Depois de examinar a análise e o exemplo monetário, o usuário respondeu
explicitamente: “Permitir após neutralizar o REFUND (recomendado)”. A decisão
aprova a cadeia 100.00 → BET 80.00 → 20.00 → REFUND da BET → 100.00 → ROLLBACK
do REFUND → 20.00 → ROLLBACK da BET → 100.00. Duas compensações diretas ainda
ativas continuam proibidas. Não se adotou crédito cumulativo de 160.00 nem uma
segunda modalidade PROCESSED sem efeito.

A coluna depois da matriz acima descreve a política aprovada e os
resultados esperados pelos testes. Sua origem continua diferenciada: unicidade
histórica por tipo é literal; a interpretação de compensação ativa foi aprovada
para a combinação ambígua. Nenhuma regra foi atribuída retroativamente ao texto
do desafio ou às Tasks 06, 11 e 12.

## Alterações implementadas

O domínio mantém a verificação de modalidade repetida antes da elegibilidade
entre tipos. A exceção estreita permite ROLLBACK de BET com REFUND anterior
neutralizado. `refundReversed` omitido ou falso mantém a rejeição conservadora;
não neutraliza ROLLBACK nem redefine a unicidade de REFUND.

O repository consulta a cadeia BET/REFUND/ROLLBACK com os três estados PROCESSED,
referências internas e externas coerentes e mesmo provider/player/wallet/moeda/
rodada/valor. O motor consulta isso depois do lock da wallet e só quando a nova
operação é ROLLBACK da BET com REFUND no histórico. HTTP, SQS e resolver usam
esse mesmo caminho. Wallet, ledger, idempotência, eventos e finalização continuam
na UnitOfWork recebida; não se acrescentaram locks de outra wallet ou referência.

Migration202610290004 instala a guarda SQL de compensação ativa e remove somente
o índice global de reversão direta criado na 280002. O índice parcial original
por referência/modalidade permanece. A guarda bloqueia a wallet e reavalia o
histórico após espera, sem movimentar dinheiro. Reversão ativa incompatível gera
23514 / wager_active_bet_compensation_check; duplicidade da modalidade gera
23505 / wager_processed_reversal_unique nos cenários isolados correspondentes.

Up não edita dados financeiros. Down reinstala primeiro o índice anterior; se o
histórico novo válido contiver duas modalidades processadas para a mesma BET,
falha com 23505 e a transação de migration preserva a guarda e o schema atual.
Nenhum registro é apagado/reclassificado para tornar a reversão possível.
Migrations antigas e proteção de terminais permanecem intactas. O teste da
migration terminal agora especifica o destino da reversão para continuar
exercitando a 290003 depois da introdução da 290004.

Os dois testes antigos que rejeitavam ROLLBACK da BET mesmo após neutralizar o
REFUND tiveram somente a expectativa incompatível atualizada: crédito integral,
versão e ledger adicionais. Os cenários de compensação ainda ativa, duplicidade,
referência incompatível, saldo insuficiente e replay foram preservados.

## Testes financeiros e distribuídos acrescentados

- Base 100.00/BET 80.00 para ambas as ordens diretas; apenas a primeira compensação
  ativa processa. Cada etapa confere saldo, versão, ledger, estado/failureCode,
  snapshot idempotente, tipos de evento e reconciliação.
- Cadeia aprovada com 80.00 e 9007199254740993.01: uma tentativa prematura rejeitada
  continua terminal; outra identidade processa após neutralização. Novo BET de
  1.00 separa o saldo atual do replay histórico, sem reaplicação/eventos novos.
- ROLLBACK de REFUND sem saldo não neutraliza a compensação. Histórico forjado
  com outro provider não fornece prova ao domínio nem à guarda SQL.
- SQL direto: restrições nomeadas, ambas as duplicidades por tipo, down/up seguro,
  recusa de down com dados novos e preservação dos registros anteriores.
- Falhas reais SQL em wallet, ledger, Wagering, idempotência, primeiro/segundo fato
  Outbox e depois da finalização: os sete casos antigos continuam, com sete
  equivalentes para a modalidade recém-elegível após neutralização.
- Dois workers disputam a modalidade recém-elegível enquanto terceiro processo
  repete a key: uma aplicação, rejeição de duplicidade e replay. Outro cenário
  mantém ROLLBACK de REFUND sem commit; worker espera wallet, terceiro processo
  avança outra wallet e o worker relê a neutralização depois do commit.
- Crash antes/depois do commit exercita a política antiga e a cadeia nova em três
  processos. Antes, nenhum efeito parcial; depois, nenhum terminal reaberto.
- HTTP, consumer e worker em três processos próprios disputam a referência nas
  variantes HTTP/worker e SQS/worker, incluindo replay SQS bloqueado pela resolução.
  Os dez fatos persistidos são publicados e comparados integralmente na saída FIFO.

## Falhas de validação diagnosticadas e corrigidas

Os testes novos de domínio/processador falharam primeiro com a política anterior
(92 passaram, dois falharam), e passaram após a correção (94/0). A integração SQL
também falhou contra o índice antigo, comprovando que alterar somente o domínio
não resolveria RE-03. Após a migration, esse cenário passou.

O pipeline revelou uma falha preexistente no harness: snapshots completos de
ambiente permitiam sobrescrever as filas descartáveis pelas configurações locais.
O primeiro teste combinado teve quatro timeouts de ACK e nove testes passaram;
isso não foi classificado como falha financeira da política. A composição agora
mantém PostgreSQL do recurso PostgreSQL e somente SQS_/AWS_ do recurso SQS, por
uma função reutilizada nos harnesses de publisher/consumer e nos exemplos.
Não houve alteração da configuração de produção para acomodar os testes.

A execução seguinte passou os dois pipelines antigos, mas as barreiras novas
buscavam PGAPPNAME customizado. ConsumerModule define application_name como
wager-consumer-PID; a instrumentação do teste passou a observar esse nome real.
Depois da correção, 14 testes distribuídos/pipelines passaram, sem falha.
Nenhum timeout foi aumentado nem regra estática relaxada para obter aprovação.

Na primeira suíte completa, 479 testes passaram e três falharam (4.704 asserções,
38 arquivos, 486,15s). A fixture de readiness herdava SQS local configurado;
passou a remover explicitamente SQS_ no ambiente da aplicação e restaurá-lo no
teardown. A fixture de unicidade SQL usava original PENDING; passou a preparar BET
PROCESSED e a verificar separadamente 23505 e a guarda 23514 nomeada. Um caller
antigo do publisher pipeline ainda mesclava snapshots completos; passou a usar
suite.env. Revalidações: 42 testes HTTP/persistência passaram e o pipeline
HTTP/SQS/publisher passou isoladamente. As três falhas foram mantidas no registro.

A revisão adicional identificou que retornar imediatamente para referências não
BET afrouxaria a exclusão cruzada antiga em SQL direto. Um teste com histórico
legado inválido REFUND(WIN) comprovou a abertura. A guarda agora conserva a
exclusão anterior para essas referências e exige a mesma wallet em todos os
casos. Essa exigência também evita coordenar a mesma referência com wallets
diferentes. A exceção por neutralização continua exclusiva de BET. Os 20 testes
de guarda/persistência financeira/publisher passaram, com 423 asserções.

O revisor reproduziu ainda uma janela anterior à FK com referência não BET ainda
PENDING: uma transação observava a wallet A, outra movia a referência para B e
confirmava a outra modalidade antes da primeira terminar. A validação SQL final
exige referência PROCESSED para toda reversão, aproveitando a imutabilidade
terminal para manter sua wallet estável. O teste específico foi vermelho antes
e passou depois, incluindo o processamento legítimo depois de confirmar a WIN.
Foundation e persistência Wagering finais: 35 passaram, zero falhas, 135 asserções
em 14,55s. A validação consolidada final foi iniciada num processo novo após
congelar essa versão de produção.

Uma execução intermediária, iniciada antes da última correção SQL, terminou com
486 testes passando e um falhando (4.774 asserções, 38 arquivos, 461,62s). O
processo já havia carregado a versão anterior da migration; o teste novo da
referência não terminal falhou nessa versão. Essa execução não é evidência da
guarda final. A execução final em processo novo, após congelar o código, passou
integralmente e está identificada na tabela de resultados.

## Revisão crítica independente

Revisor separado tentou encontrar crédito indevido, neutralizador incompatível,
perda de unicidade, inversão de locks, falhas de replay/terminalidade e problemas
no novo harness. Os achados SQL descritos acima foram corrigidos e reexaminados;
no estado final, o revisor encerrou o P2 sem bloqueio remanescente. A revisão
documental separada também não encontrou defeito concreto.

O revisor executou uma prova adicional em PostgreSQL descartável próprio: duas
transações SQL inserindo REFUND e ROLLBACK diretamente, com a primeira segurando
wallet e a segunda observada em wait_event_type=Lock. Depois do commit do REFUND,
o ROLLBACK recebeu exatamente 23514 / wager_active_bet_compensation_check; somente
o REFUND persistiu. O teardown foi concluído. Isso exercita a proteção SQL sem
depender exclusivamente dos locks do caso de uso.

## Evidências executadas

| Etapa                                                  | Resultado                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline focal antes da implementação                  | 102 passaram, 0 falharam, 581 asserções, quatro arquivos, 26,41s                                                                                                          |
| Unidade após correção                                  | 94 passaram, 0 falharam, 441 asserções                                                                                                                                    |
| Processador SQL e persistência Wagering após migration | 41 passaram, 0 falharam, 1.296 asserções, 16,83s; anterior aos três testes adicionais de constraints                                                                      |
| Constraints Wagering antes das bordas finais           | 8 passaram, 0 falharam, 46 asserções, 6,64s                                                                                                                               |
| Matriz financeira real de RE-03                        | 5 passaram, 0 falharam, 286 asserções, 7,09s                                                                                                                              |
| Pendências, falhas SQL e recuperação                   | 40 passaram, 0 falharam, 613 asserções, 40,64s; anterior à corrida e à barreira de neutralização adicionais                                                               |
| Distribuídos e pipelines finais                        | 14 passaram, 0 falharam, 273 asserções, 52,33s                                                                                                                            |
| typecheck, lint/arquitetura e build                    | Aprovados; 109 módulos e 391 dependências, sem violações                                                                                                                  |
| Documentação após fechamento                           | 4 passaram, 0 falharam, 164 asserções                                                                                                                                     |
| Suíte completa e Docker                                | 487 passaram, 0 falharam, 4.775 asserções, 38 arquivos, 460,25s. Inclui PostgreSQL/LocalStack reais, três processos, crashes, Docker build/smoke e exemplos operacionais. |

Comandos usados para reprodução e fechamento:

```sh
bun test test/wager-transaction.test.ts test/process-wager.test.ts
bun test test/wagering-persistence.test.ts test/re03-conformance.test.ts
bun test test/pending-persistence.test.ts test/pending-distributed.test.ts test/pending-pipeline.test.ts
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build
bun test test/documentation.test.ts
bun run graph:update
git diff --check
```

O build/smoke Docker integra a suíte completa: API/consumer, publisher e worker
compilados, SIGTERM e deadline reais. Os fluxos novos mantiveram saldo/ledger,
versão, eventos e snapshot idempotente consistentes. A suíte preserva a cobertura
anterior e acrescenta 29 testes e 625 asserções à baseline 458/4.150.

Graphify atualizado após as alterações; a navegação localizou motor compartilhado,
repository, portas e migration. O índice é estrutural, sem LLM/API, e não prova
as garantias financeiras. Onze arquivos sem símbolos individuais incluem
entrypoints e reexports conferidos diretamente. Links/âncoras locais, frontmatter,
comandos, rotas e exemplos foram revalidados após fechar este relatório; não se
atesta disponibilidade permanente de URLs externas. `git diff --check` e a
conferência do conteúdo protegido encerram a validação.

Exemplos de processos observados na execução final:

| Cenário                                                           | PIDs e resultado                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workers disputam modalidade nova e terceiro processo repete a key | 17592, 25468, 12440: PROCESSED, REJECTED por duplicidade e REPLAY; saldo 100.00, versão 5                                            |
| Neutralização ainda sem commit                                    | 17552 segura ROLLBACK de REFUND; 2460 espera wallet; 25372 confirma outra wallet antes da liberação. Depois do commit, 2460 processa |
| Crash antes de commit, cadeia nova                                | 17192 morto na barreira; 21856 recupera após lease; 9836 observa ausência de trabalho. Nenhum efeito parcial                         |
| Crash depois de commit, cadeia nova                               | 17112 morto após commit; 12008 e 2100 não selecionam terminal. Nenhum novo movimento                                                 |
| HTTP REFUND contra ROLLBACK SQS                                   | API 24420, consumer 13800, worker 3604 em outra wallet. Final 100.00 e um crédito compensatório                                      |
| HTTP ROLLBACK contra REFUND SQS                                   | API 7752, consumer 25384, worker 22484. Mesmo resultado financeiro                                                                   |
| Worker da modalidade nova contra HTTP                             | API 2544, consumer 17632 e worker 25388; concorrente rejeitado e replay SQS seguro                                                   |
| Worker da modalidade nova contra SQS                              | API 24316, consumer 11220 e worker 20152; uma aplicação e dez fatos confirmados publicados                                           |

Barreiras de commit, pg_stat_activity, leases e estado persistido sustentam esses
resultados; os PIDs identificam esta execução e não são configuração permanente.

## Preservação e inventário desta tarefa

Uma árvore temporária de HEAD com o patch inicial da Task 12 aplicado permitiu
comparar a baseline ao resultado desta tarefa. Conteúdo staged original preservado:
o patch do index permaneceu idêntico byte a byte. Conteúdo de 23 arquivos
protegidos permanece igual, normalizando
somente CRLF/LF e BOM na comparação: enunciado, cinco migrations anteriores e
relatórios/planos históricos. O índice de histórico recebeu somente o link novo.

Criados: este relatório, Migration202610290004.ts e test/re03-conformance.test.ts.

Alterados em relação à baseline da Task 12:

```text
ARCHITECTURE.md
README.md
docs/architecture/concurrency.md
docs/domain/wagering.md
docs/history/README.md
docs/persistence.md
docs/requirements.md
src/modules/wagering/adapters/persistence/mikro-orm-wager-transaction.repository.ts
src/modules/wagering/application/process-wager.ts
src/modules/wagering/domain/wager-transaction.ts
src/modules/wagering/public/persistence.ts
src/platform/persistence/config.ts
test/documentation-examples.test.ts
test/http-api.test.ts
test/pending-distributed.test.ts
test/pending-persistence.test.ts
test/pending-pipeline.test.ts
test/pending-worker.test.ts
test/persistence.test.ts
test/process-wager-persistence.test.ts
test/process-wager.test.ts
test/publisher-pipeline.test.ts
test/sqs-consumer.test.ts
test/support/pending.ts
test/support/publisher-sqs-suite.ts
test/support/sqs.ts
docs/testing/strategy.md
test/wager-history.test.ts
test/wager-transaction.test.ts
test/wagering-persistence.test.ts
```

## Estado e limites

RE-03 é IMPLEMENTED com evidência financeira, SQL, multiprocesso e de recuperação,
sob a interpretação adicional aprovada. Nenhum check obrigatório ficou pendente.
O resultado da Task 12 anterior continua histórico e não foi reescrito. Nenhum
commit ou push foi feito.
Não há migração financeira retroativa, nova fila, publisher adicional ou mudança
dos contratos HTTP/SQS/eventos v1. O modelo continua at-least-once no transporte,
com efeitos financeiros únicos no banco. Backups/falha física, IAM gerenciada e
carga permanecem fora da evidência local. A política de compensação ativa é uma
interpretação aprovada da combinação ambígua, sem alterar o enunciado.
