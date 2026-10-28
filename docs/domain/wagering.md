# Wagering: operações, estados e idempotência

Requisitos **explícitos** dos §§3, 6.0, 6.3–6.4, 7–11 e 13 de [challenge.md](../challenge.md). O original permanece primário e imutável. A [Arquitetura](../../ARCHITECTURE.md) aprova ProcessWagerUseCase como orquestrador compartilhado por HTTP/SQS; nenhuma operação está implementada.

## Operações (§§6.3–6.4, 7, 9)

| Kind     | Efeito / ledger quando aplicável              | Referência e condição explícita                                         |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| BET      | Débito / uma DEBIT                            | Rejeitar saldo insuficiente                                             |
| WIN      | Crédito / uma CREDIT                          | Pode referenciar BET da mesma rodada                                    |
| LOSS     | Sem saldo / sem ledger                        | Registra resultado; processada também emite WagerTransactionProcessed   |
| REFUND   | Crédito / uma CREDIT                          | Exige BET PROCESSED; mesmo valor, reversão integral                     |
| ROLLBACK | Inverso da referência / uma entrada invertida | Exige BET, WIN ou REFUND PROCESSED; mesmo valor, reversão integral      |
| OPENING  | Crédito interno de abertura / CREDIT          | Inicial positivo, mesma transação SQL da wallet; proibido em API e fila |

Contratos de Money, saldo/versão e ledger pertencem a [Financial](financial.md). Transação REJECTED não altera saldo nem gera ledger. Não introduzir fluxos financeiros independentes nos adapters de transporte.

## Identidade e referências (§§6.3, 7–7.1)

Modelo de referência registra id interno, providerId, externalTransactionId, idempotencyKey, payloadHash, walletId, playerId, roundId, gameId, kind, Money, referenceExternalTransactionId, createdAt, status, referenceTransactionId interno resolvido, failureCode e processedAt. Estado encapsulado com factories; rehydrate não reaplica transições (§6.0).

- REFUND/ROLLBACK exigem referenceExternalTransactionId, **ID externo do provedor**, não ID interno.
- Resolver por `(providerId, referenceExternalTransactionId)`; referência deve compartilhar provider, player, wallet, moeda e rodada. O §7 não exige mesmo gameId; não adicionar essa restrição.
- REFUND só referencia BET; ROLLBACK somente BET/WIN/REFUND. A referência deve estar PROCESSED para ser revertida.
- Uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de operação. Não substituir por proibição global de qualquer segunda reversão sem decisão explícita.
- REFUND/ROLLBACK devem igualar o valor referenciado; reversão parcial fora do escopo.
- Referência ausente exige PENDING_REFERENCE persistente e evento correspondente; worker agendado reprocessa com backoff exponencial.
- Definir e justificar tentativas ou TTL. Ao esgotar, REJECTED com código que identifique referência inexistente e evento de rejeição. Valores e política de aquisição concorrente permanecem pendentes.
- Reversão que produziria saldo negativo é rejeitada auditavelmente, com failureCode **distinto** da BET sem saldo. Toda rejeição usa código estável e legível por máquina (§7.2); taxonomia não foi definida.

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

A tabela registra caminhos exigidos pelo texto, **não uma matriz definitiva aprovada**. Retorno intermediário a PENDING, repetição de markPendingReference, timestamps e tratamento de referência existente mas não PROCESSED precisam de desenho documentado antes da implementação. Falha transitória não é automaticamente FAILED terminal. Reidratar e retornar replay não são transições de estado.

## Idempotência e replay (§§5, 6.3, 7, 9–10)

HTTP exige header Idempotency-Key como fonte da verdade; `"{providerId}:{externalTransactionId}"` é default **recomendado**, sem dispensar header. SQS fornece data.idempotencyKey. Idempotência é persistente e segura sob duplicatas concorrentes, independentemente da Inbox de [Messaging](messaging.md).

payloadHash usa JSON canônico com chaves ordenadas do subconjunto dos campos de negócio; header/metadados de transporte ficam fora. Algoritmo, campos exatos, normalização, escopo de unicidade e armazenamento da resposta precisam ser documentados, sem escolher hash arbitrariamente nesta etapa.

Repetição idêntica de operação já processada devolve **resultado original**, inclusive saldo observado naquela execução; resposta marca idempotentReplay true. Não consultar saldo atual para substituir o histórico nem reaplicar débito/crédito/ledger/eventos. Mesma key com payload diferente é conflito, nunca replay. Comportamento exato de replay de resultados pendentes/rejeitados/falhos e sua evolução ainda requer contrato, preservando terminalidade e resultado processado original.

## Pontos a esclarecer sem inventar resolução

- §6.1 rejeita negativos na entrada, mas não proíbe zero para apostas; §7 descreve um lançamento para operações financeiras e §6.2/§11 condicionam versão/evento à mudança de saldo. Definir zero por kind antes de implementar; não impor mínimo positivo ou gerar movimentação fictícia.
- §7 limita reversão por **tipo**. Interação de REFUND e ROLLBACK sobre a mesma BET e cadeias de reversão precisa de interpretação registrada, sem alterar a regra explícita.
- Referência opcional de WIN: validar contexto explícito quando informada; destino de referência existente ainda não processada/rejeitada e autocitação não foram definidos.
- Identidade externa consta na consulta e na resolução de referência, mas restrições exatas entre externalTransactionId e idempotencyKey diferentes precisam de desenho de unicidade, sem inventar regra de replay.
- §6.3 descreve FAILED terminal, enquanto §10 prevê DLQ para permanentes. Coordenação entre status de negócio e transporte ainda pendente.

Requisitos de eventos estão em [Messaging](messaging.md); não há códigos de erro, status HTTP ou limites novos aprovados. Divergências devem ser reportadas e registradas, mantendo o enunciado intacto.
