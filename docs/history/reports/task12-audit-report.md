# Task 12: auditoria funcional e documental

Data: 2026-10-29. Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.0.

## Fase A: diagnóstico anterior às alterações

O enunciado foi lido integralmente antes de produzir esta auditoria. A inspeção
conferiu domínio, casos de uso, adapters, quatro migrations e cenários de testes.
O grafo localizou os símbolos; consultas genéricas de observabilidade não tiveram
resultado e foram complementadas por busca restrita em `src/platform`,
`src/bootstrap` e adapters. Nomes de testes indicam cobertura pretendida; aprovação
depende da execução. Nenhum documento foi movido nesta fase.

| Prioridade   | Requisito                                              | Estado preliminar     | Constatação e ação                                                                                                                                                                             |
| ------------ | ------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1           | §§5.9, 6.3: terminais imutáveis no schema              | PARTIALLY_IMPLEMENTED | Domínio e repository impedem transições; SQL direto ainda pode alterar terminais. Acrescentar migration reversível e teste PostgreSQL de violação.                                             |
| P2           | §§9, 12: observabilidade                               | PARTIALLY_IMPLEMENTED | Consumer/publisher/worker têm logs e alguns contadores; faltam logs HTTP e medições de status, duplicatas, conflitos de lock e DLQ. Acrescentar instrumentação sem mudar o caminho financeiro. |
| P2           | §9: erro transitório HTTP distinto                     | PARTIALLY_IMPLEMENTED | Filtro não classifica cancelamento/timeout SQL como indisponibilidade. Acrescentar códigos e verificar HTTP real.                                                                              |
| Política     | §7.4: reversões por modalidade                         | PARTIALLY_IMPLEMENTED | Política aprovada na Task 06 é mais restritiva: REFUND e ROLLBACK diretos não acumulam. Preservar a decisão e registrar a divergência literal, sem anunciar conformidade integral.             |
| Validar      | §§5, 6.1, 6.2, 6.4, 8: dinheiro, ledger e concorrência | UNVERIFIED            | Inspeção encontrou bigint/string NUMERIC, constraints, ledger append-only, locks por wallet e versão condicionada. Testes existentes precisam passar nesta execução.                           |
| Validar      | §§6.5, 10, 11: Inbox, ACK, Outbox e recuperação        | UNVERIFIED            | Mesma UnitOfWork financeira; ACK após resolução da Promise de commit; claims/lease/token SQL. Validar containers, três processos, janelas de crash e publicação incerta.                       |
| Validar      | §§7.1, 7.2: referências pendentes                      | UNVERIFIED            | Resolver existente compartilha motor, usa TTL de 24h, backoff e fencing final. Validar resolução, expiração e rollback dos efeitos após perda de claim.                                        |
| Documentação | §§2, 4, 14                                             | PARTIALLY_IMPLEMENTED | Setup e decisões existem, mas referências atuais misturam etapas históricas e afirmações futuras já entregues. Reorganizar somente depois da estabilização.                                    |
| Opcional     | §§2, 6.4, 12, 14                                       | NOT_IMPLEMENTED       | IdP, partidas dobradas, OpenTelemetry/dashboard e carga não são necessários para aceitação. Guard no-op e desenho de IdP existem.                                                              |

A revisão independente confirmou as três lacunas funcionais acima e a restrição
de reversões. A suíte completa foi iniciada sobre a implementação anterior às
correções, incluindo PostgreSQL/LocalStack, multiprocesso e Docker. Seu resultado
será registrado separadamente do resultado após as correções.

## Aceitação e sequência

1. Corrigir as lacunas com teste observável, preservando ledger e migrations antigas.
2. Executar unidade, PostgreSQL/LocalStack, concorrência/recuperação, arquitetura,
   build e smoke Docker pelo workflow existente.
3. Registrar o estado estabilizado antes de inventariar e mover os documentos.
4. Revisar fontes atuais por responsabilidade, preservar relatórios e planos,
   construir matriz detalhada e validar links, exemplos, comandos e Mermaid.
5. Solicitar revisão independente da documentação final e repetir checks afetados.

A redação nova segue o [Humanizer](https://github.com/blader/humanizer/blob/main/SKILL.md):
frases diretas e afirmações sustentadas por evidência. Código, números, datas e
resultados históricos não são modificados por razões de estilo.

## Fase B: estado estabilizado antes da reorganização

- Migration202610290003 protege UPDATE/DELETE de terminais e TRUNCATE do histórico
  Wagering. O teste PostgreSQL valida os três estados, resolução de pendência e
  down/up sem perda de dados. Migrations anteriores permanecem intactas.
- HTTP reconhece SQLSTATE 57014, 25P03 e 25P04 como falhas transitórias (503).
- HTTP, consumer, publisher e worker emitem amostras de métricas JSON. A medição
  de conflito SQL foi observada em lock_timeout real; logs HTTP foram conferidos
  contra dinheiro, playerId e key. Não há exporter nem armazenamento de métricas.
- Revisão independente corrigiu instrumentação de rotas com barra final/caixa
  diferente e sequenciamento do teste SQL antes das migrations.

Verificações anteriores à movimentação documental:

| Verificação                                       | Resultado                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Suíte inicial da auditoria                        | 447 passaram, 0 falharam, 3.912 asserções, 33 arquivos (524,18s); não comprova as correções posteriores   |
| Novas verificações focalizadas                    | 46 passaram, 0 falharam; PostgreSQL, HTTP, TTL/migrations e observabilidade                               |
| Consumer/SQS/observabilidade/schema               | 14 passaram, 0 falharam; LocalStack real                                                                  |
| Suíte após correções                              | 451 passaram; 1 falha no protocolo do harness, que confundia log de conflito com sinal do filho (474,46s) |
| Correção da falha do harness                      | 16 testes financeiros passaram, 0 falharam, 136 asserções; inclui métrica real de 55P03                   |
| typecheck, lint/arquitetura e build               | Aprovados; nenhuma regra estática relaxada                                                                |
| Docker, multiprocesso, concorrência e recuperação | Incluídos na suíte após correções; nenhuma falha comportamental além do harness identificado              |

A reorganização começa após essa execução e a revalidação do único teste afetado
pelo harness. A suíte completa foi repetida após a documentação na Fase D.
A restrição conservadora de reversões continua explícita; não se declara
conformidade literal integral com §7.4. Autenticação, double-entry, carga,
OpenTelemetry e dashboard permanecem opcionais e ausentes.

## DOC-A e DOC-C: inventário e estrutura escolhida

O inventário anterior continha 41 Markdown versionados, incluindo instruções de
agentes e skills. A checagem inicial encontrou 614 links relativos e nenhum
caminho inexistente. Isso não validava âncoras nem a veracidade das afirmações.

README acumulava setup, regras de lint e cronologia. ARCHITECTURE misturava
decisões atuais com a fundação histórica. Os três domínios e persistence.md
repetiam estados de entrega e evidências antigas. Contratos HTTP e runbooks
ficavam na raiz de docs; planos em docs/superpowers/plans; cinco relatórios de
tasks também ficavam na raiz de docs.

A estrutura mínima mantém domínios e persistência, separa contratos, operação,
testes e histórico, e acrescenta índice e fluxos/concorrência. As decisões
estruturais continuam em ARCHITECTURE.md; não há decisão nova que justifique ADR.
Relatórios e planos preservam resultados e datas. Somente links e a identificação
de conteúdo histórico serão ajustados nesses arquivos.

## DOC-B: afirmações e evidências

| Afirmação auditada                               | Classificação final e evidência                                                                          | Correção ou limite                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Precisão Money e serialização                    | IMPLEMENTED: Money/ExactNumericType, CHECK NUMERIC; money.test e financial-persistence.test              | Sem float e sem arredondar entrada inválida; limites físicos SQL permanecem                          |
| Idempotência financeira persistente              | IMPLEMENTED: scope/key/hash/result JSONB, UNIQUE, process-wager-persistence.test e http-concurrency.test | Resultado PROCESSED histórico; snapshot pendente evolui para terminal, sem reabrir terminal          |
| Atomicidade PostgreSQL                           | IMPLEMENTED: TransactionSession compartilhada, UnitOfWork, inbox.test e process-wager-persistence.test   | Não equivale a impor soma saldo/ledger por trigger contra SQL arbitrário                             |
| Concorrência entre instâncias                    | IMPLEMENTED: locks por wallet/identidade e versão; três processos HTTP/SQS/SQL                           | Sem promessa de throughput, ausência universal de deadlock ou lock distribuído em memória            |
| Imutabilidade terminal SQL                       | IMPLEMENTED após correção: migration 290003 e wager-history.test                                         | Antes era PARTIALLY_IMPLEMENTED, só domínio/repository                                               |
| ACK após commit                                  | IMPLEMENTED: ReliableConsumer aguarda use case; crash-before/after-commit em sqs-consumer.test           | DeleteMessage não é atômico com SQL; Inbox recupera redelivery                                       |
| Claims/lease/fencing e retomada                  | IMPLEMENTED: stores e finish condicionais; publisher/pending persistence e recovery                      | Fencing impede UPDATE obsoleto; não impede envio SQS já aceito                                       |
| Publicação at-least-once                         | IMPLEMENTED: envelope/eventId estáveis e testes com aceite incerto                                       | Removida qualquer leitura de exactly-once ou ordem de commit na saída; downstream precisa deduplicar |
| Reconciliação consistente                        | IMPLEMENTED: REPEATABLE READ READ ONLY e teste com commit entre leituras                                 | Histórico inteiro em memória; não corrige automaticamente                                            |
| Referências pendentes                            | IMPLEMENTED: resolver compartilhado, TTL/backoff e testes de fencing/expiração                           | Original elegível após TTL ainda processa; erro técnico não causa rejeição financeira                |
| Observabilidade obrigatória                      | IMPLEMENTED como amostras JSON e sinais de processo, conferidos em HTTP/SQL/SQS                          | Sem backend/exporter/durabilidade de métricas; não são fonte de contagem financeira exata            |
| Outra reversão direta de modalidade diferente    | PARTIALLY_IMPLEMENTED em relação à redação literal: política anterior mais restritiva                    | Decisão conservadora preservada e registrada em RE-03; não ocultada por redação                      |
| Relatos de etapas sem consumer/publisher/worker  | HISTORICAL                                                                                               | Preservados nos relatórios; removidos das referências atuais                                         |
| IdP e operação futura com múltiplas wallets      | PLANNED                                                                                                  | Desenho explicitamente separado; não anunciado como entregue                                         |
| OTel/dashboard, carga, double-entry e downstream | NOT_IMPLEMENTED                                                                                          | Extras/limites, sem requisitos obrigatórios inventados                                               |

Foram corrigidos os textos de Outbox ainda PENDING sem publisher, referências
aguardando worker futuro, código de expiração reservado e abertura/queries ainda
não entregues. Contagens antigas de testes saíram das referências atuais e
permaneceram nos relatórios datados. A regra antiga de tooling que prescrevia main
e 500 linhas por commit não consta das instruções Git desta tarefa; foi retirada
da referência atual e preservada como registro histórico.

## DOC-D: estrutura, consolidações e histórico

Estrutura final:

```text
README.md / ARCHITECTURE.md
docs/index.md / challenge.md / requirements.md / persistence.md
docs/architecture/   data-flow.md, concurrency.md
docs/domain/         financial.md, wagering.md, messaging.md
docs/contracts/      http.md, sqs-commands.md, integration-events.md
docs/operations/     local-development.md, consumer.md, publisher.md,
                     pending-worker.md, failure-recovery.md, observability.md
docs/testing/        strategy.md, distributed-scenarios.md
docs/history/        README.md, reports/, plans/
docs/tooling/        graphify.md, ponytail.md
```

Movimentações de arquivos inteiros:

| Origem anterior em docs/                                            | Destino em docs/                                |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| http-api.md                                                         | contracts/http.md                               |
| sqs-consumer.md                                                     | operations/consumer.md                          |
| outbox-publisher.md                                                 | operations/publisher.md                         |
| pending-reference-worker.md                                         | operations/pending-worker.md                    |
| task07-outbox-report.md a task11-pending-report.md (cinco arquivos) | history/reports/, nomes preservados             |
| task12-audit-report.md, iniciado antes das correções                | history/reports/task12-audit-report.md          |
| financial-persistence-proposal.md                                   | history/plans/financial-persistence-proposal.md |
| superpowers/plans/ (cinco planos)                                   | history/plans/, nomes preservados               |

Criados: índice, dois documentos de arquitetura, contratos SQS/eventos, guia local,
recuperação, observabilidade, estratégia/cenários de teste e índice de histórico.
Extraídos sem alterar fatos: task06-process-wager-report.md,
financial-integration-report.md, persistence-foundation-report.md e
wagering-core-report.md. Registros de recuperação dos dois toolings foram
concentrados em tooling-recovery-report.md. Não foram apagados relatórios ou planos;
os caminhos antigos desapareceram por movimentação/consolidação, sem stubs vazios.

Consolidações: Financial detém Money/Wallet/ledger/reconciliação; Wagering detém
reversões, estados, hash/replay e resolução; Messaging detém Inbox/ACK/publicação;
contratos detêm envelopes/respostas; persistence detém schema/SQL; operações detêm
comandos/configuração/recuperação; requirements detém cobertura. README aponta
para essas fontes e não reproduz cronologia. ARCHITECTURE mantém decisões e
trade-offs sem tabela de uma fundação anterior apresentada como sistema atual.

Os fluxos foram redesenhados em texto versionável: arquitetura, HTTP, Inbox/ACK,
Outbox/publisher, referência pendente e estados. Limites de commit e envio incerto
estão explícitos. Não foi usada dependência Mermaid nem renderer que o leitor
precise instalar. Os diagramas são conferidos contra os símbolos ligados no texto.

A redação atual e este relatório aplicam Humanizer em modo incorporado, sem
alterar campos de contrato, comandos, exemplos ou resultados para fins estilísticos.
Na prosa antiga preservada, só navegação/classificação e formatação são ajustadas.

## DOC-E: rastreabilidade e leitura sem histórico

A [matriz completa](../../requirements.md) inclui obrigatoriedade, estado,
implementação, testes, documento proprietário, limites e referência às execuções.
RE-03 mantém a divergência de reversões; extras ficam separados de obrigações.
Não há alegação de conformidade literal total do desafio.

O percurso do novo engenheiro começa no README e índice: identifica processos,
provisiona/aplica migrations, inicia os quatro terminais, cria wallet e BET por
HTTP, envia SQS, consulta transações/ledger, reconcilia, observa saída e encontra
recuperação/testes. Esse percurso é exercitado pelo teste de exemplos publicados,
sem exigir conhecimento das Tasks 01 a 11.

## Fase D: validação final

A retomada encontrou a reorganização e as correções da Fase B preparadas no
workspace, com esta etapa ainda pendente. O ambiente estava sem node_modules e
com Docker desligado. A primeira tentativa de verificação falhou por pacotes
ausentes, antes de exercitar as integrações. Foram restauradas as dependências
com `bun install --frozen-lockfile` e iniciado Docker Desktop. Ambiente da
retomada: Windows/PowerShell, Bun 1.4.4 e Docker Engine 29.8.1.

### DOC-G: revisão independente e correções

Dois revisores separados conferiram documentação e alterações executáveis, sem
editar arquivos nem substituir a execução completa pelo coordenador. A revisão
documental leu o enunciado integral, matriz, fontes atuais e histórico, comparando
contratos e fluxos aos fontes/testes. A revisão executável examinou migrations,
HTTP, instrumentação, claims, ACK e harness; reproduziu os problemas de logs e
TRUNCATE em ambiente descartável.

| Achado                                                            | Correção e evidência                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Erros HTTP copiavam identidades de um body rejeitado              | Filtro/interceptor não extraem IDs do body na falha. Novo teste HTTP para wallet e Wagering falhou antes da correção ao encontrar conteúdo inválido nos logs e passou depois. Sucesso/replay continuam correlacionados. |
| TRUNCATE podia passar no teste graças ao trigger antigo do ledger | A asserção exige também a mensagem da proteção Wagering. A reprodução independente mostrou que remover apenas wager_no_truncate troca a mensagem, mantendo SQLSTATE 55000; o teste fortalecido distingue as proteções.  |
| Exemplo SQS mantinha IDs FIFO literais após mudar message.json    | Runbook exige sincronizar groupId com walletId e deduplicationId com messageId, e explica supressão de mensagem nova mesmo com SendMessage bem-sucedido.                                                                |
| Lint dos testes documentais e formatação pendentes                | Verificação do diretório temporário movida antes do try/finally, sem mascarar erro original; interpolação redundante removida. Prettier aplicado, sem relaxar regras.                                                   |

Os revisores reexaminaram as correções e encerraram os três achados técnicos.
Não restou achado acionável nessas revisões. Isso não amplia a cobertura para
AWS gerenciada, downstream, falha física de disco ou requisitos opcionais.

### DOC-F: evidências de execução

| Verificação na retomada                                     | Resultado                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primeira suíte completa após a reorganização                | 457 passaram, 0 falharam, 4.141 asserções, 37 arquivos, 448,28s. A correção dos logs HTTP e o teste novo foram revalidados separadamente e incluídos na execução final abaixo.                                                                        |
| Regressão dos logs antes da correção                        | Teste HTTP novo falhou ao detectar identidades rejeitadas nos logs; falha intencional que reproduz o problema, sem erro de setup.                                                                                                                     |
| HTTP e histórico após correções de revisão                  | 19 passaram, 0 falharam, 178 asserções em 18,77s; inclui o teste novo e migrations/SQL reais.                                                                                                                                                         |
| Links, âncoras, frontmatter, scripts, rotas, JSON e parsers | 4 passaram, 0 falharam, 162 asserções. Exemplos operacionais também fazem parte da suíte completa.                                                                                                                                                    |
| typecheck                                                   | Aprovado após a correção executável final.                                                                                                                                                                                                            |
| lint, incluindo arquitetura                                 | Aprovado: 108 módulos, 389 dependências, nenhuma violação; nenhuma supressão adicionada.                                                                                                                                                              |
| build                                                       | Aprovado após a correção executável final; os quatro entrypoints continuam compilados.                                                                                                                                                                |
| format:check                                                | Aprovado após aplicar o formato existente; verificação repetida após a consolidação deste relatório.                                                                                                                                                  |
| Suíte completa com todos os ajustes de revisão              | 458 passaram, 0 falharam, 4.150 asserções, 37 arquivos, 427,25s. Inclui PostgreSQL/LocalStack reais, multiprocesso, concorrência, recuperação, exemplos publicados e smoke Docker.                                                                    |
| Graphify                                                    | Índice atualizado após as alterações; consultas localizaram WagerDiagnosticsInterceptor e Migration202610290003 e suas relações. Extração estrutural não substitui código/testes; 11 arquivos sem símbolos extraídos incluem entrypoints e reexports. |
| Integridade da alteração                                    | git diff HEAD --check aprovado; challenge.md idêntico ao blob de HEAD; package.json e lockfile sem mudanças.                                                                                                                                          |

Exemplos de evidência multiprocesso registrados pela primeira suíte da retomada:

| Cenário                                            | Processos/barreira                                                      | Resultado observado                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Wallet compartilhada no processador SQL            | PIDs 20656, 17440 e 17992; before-commit e blockedPids confirmam espera | Três BETs serializadas, sem lost update; reconciliação validada pelo teste. |
| Disputa 100/80/80 por SQS                          | PIDs 23680, 23688 e 9156; contenção SQL real                            | Saldo 20.00, exatamente um débito.                                          |
| Cinquenta mensagens para uma identidade financeira | PIDs 24512, 4300 e 18516                                                | 50 participações Inbox, uma aplicação financeira.                           |
| Publishers concorrentes                            | PIDs 17832, 1304 e 22712; envios retidos em paralelo                    | Claims exclusivos, sem transação SQL aberta durante a rede.                 |
| Morte após commit/antes de ACK                     | PID 22820 encerrado; PID 12820 recuperou por redelivery, receiveCount 3 | Nenhum efeito financeiro adicional; Inbox e saldo reconstruído conferidos.  |

Contagens e PIDs identificam esta execução, não parâmetros permanentes do sistema.
Os comandos reproduzíveis e as barreiras pertencem aos testes ligados na
[estratégia](../../testing/strategy.md) e nos
[cenários distribuídos](../../testing/distributed-scenarios.md).

Os checkpoints DOC-A a DOC-G estão concluídos. DO-01 passa a IMPLEMENTED na
matriz, com evidência executável e revisão independente encerrada. A entrega da
auditoria não significa conformidade literal total: RE-03 continua
PARTIALLY_IMPLEMENTED e os extras permanecem ausentes conforme sua classificação.

Não ficaram checks obrigatórios desta tarefa sem execução. A validação de links
cobre caminhos e âncoras locais, sem comprovar disponibilidade permanente de URLs
externas. Os diagramas de texto foram revisados contra os fluxos reais; não há
blocos Mermaid dependentes de renderer. Os limites de AWS gerenciada, observação
best effort, downstream, carga e recuperação física permanecem explícitos nas
fontes responsáveis, sem garantias acrescentadas por esta auditoria.

Nenhum commit ou push foi feito; alterações de implementação e documentação
permanecem identificáveis por arquivo no diff. A branch preexistente
feat/pending-reference-worker foi preservada. Nenhuma dependência nova foi
adicionada ao projeto; a retomada apenas reinstalou as versões do lockfile.
Não foram instaladas ferramentas pesadas para validar documentos.
