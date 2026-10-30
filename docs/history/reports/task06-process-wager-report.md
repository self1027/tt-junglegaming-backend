# task06 process wager report

> HISTORICAL: trecho preservado de `docs/persistence.md`; resultados pertencem ao checkpoint original. Estado atual em [docs/index](../../index.md).

## Task 06 — processamento atômico

Contrato e políticas são definidos em [Wagering](../../domain/wagering.md#políticas-e-reversões), sem duplicar aqui regras financeiras. `ProcessWagerUseCase` usa uma única execução do contexto estendido. `MikroOrmIdempotencyRepository` e `MikroOrmWagerTransactionRepository` recebem a mesma TransactionSession dos adapters Financial. Não abrem transação nem fazem commit próprios. Mappers explicitam nulabilidade, Money decimal e reidratação dos cinco estados; metadados de retry ficam fora do domínio. `insertProcessed` permanece compatível.

Ordem de recursos: claim scope/key (INSERT ON CONFLICT e leitura FOR UPDATE quando existente) → advisory transaction lock da tupla de identidade externa → resolução player/moeda e wallet FOR UPDATE → referência/histórico → Wagering → wallet/ledger quando mudam → idempotency COMPLETED → commit. Replay retorna snapshot JSONB sem adquirir wallet nem gravar efeitos. Hash divergente e identidade externa com outra key são erros de aplicação; a reserva desta tentativa é revertida. Nenhuma key confirmada pendente permanece IN_PROGRESS.

`PENDING_REFERENCE` representa ausência, FK nula. Referência existente ainda em processamento mantém a operação em PENDING; resultado JSONB guarda motivo NOT_PROCESSED e ID/status observado. Replays pendentes não reavaliam a referência. Futuro worker deverá localizar ambos os estados, adquirir a coordenação descrita e atualizar atomicamente somente resultado não terminal; essa porta/worker não foi antecipada. `save` não sobrescreve estados terminais e não reseta metadados técnicos.

### Migration adicional

[Migration202610280002](../../../src/platform/persistence/migrations/Migration202610280002.ts) adiciona `wager_processed_direct_reversal_unique(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`. O índice anterior por modalidade permanece. Rejeições não participam do predicado; ROLLBACK de REFUND tem outro ID referenciado. Up falha sobre histórico cumulativo incompatível sem excluir registros; down remove somente o índice, preservando histórico. Rollback integral da fundação continua recusando ledger confirmado; testes usam `--to 0` para verificar essa proteção com as duas migrations.

### Evidências executáveis

Ambiente: Windows/PowerShell, Bun 1.4.4, Docker Engine 29.8.1, PostgreSQL 18.3 real em projetos/volumes descartáveis. Harness existente em [support/postgres.ts](../../../test/support/postgres.ts), filhos independentes em [wager-process.ts](../../../test/support/wager-process.ts) com pools próprios de duas conexões. stdin fornece barreiras bufferizadas; sinais JSON registram PIDs. `pg_stat_activity.wait_event_type = 'Lock'` confirma contenção antes da liberação; polling limitado a 5s, sinais com deadline de 10s. Sem sleeps usados como prova de corrida.

- [Unidade](../../../test/process-wager.test.ts): cinco operações, zero, reversões e cadeias, insuficiências distintas, referências ausente/em processamento/terminal/incompatível, replay histórico, conflitos e propagação de falhas técnicas.
- [Portas SQL](../../../test/wagering-persistence.test.ts): cinco estados e precisão acima de 53 bits; reserva/conclusão/rollback; up/down/up do índice com histórico preservado; violação direta da unicidade cruzada; atualização não terminal e recusa de reabertura.
- [Processador SQL](../../../test/process-wager-persistence.test.ts): commits completos BET/WIN/LOSS; rejeições/pendências sem efeitos; rollback em falhas SQL de Wagering, wallet, ledger e conclusão idempotente, seguido de retry seguro; replay histórico; conflitos e independência de providers; inversas e cadeias; estados de referência; insuficiência de reversão.
- Três processos disputando a mesma wallet: três BETs resultam em 70.00, versão 4, três débitos mais OPENING. Wallets distintas confirmam enquanto a terceira mantém lock. Rollback do detentor seguido de duas BETs de 80.00/100.00 resulta em uma PROCESSED, uma REJECTED, saldo 20.00, versão 2 e um débito de 80.00.
- Mesma key em três processos e 50 submissões distribuídas em três pools: um débito/uma transação/um registro idempotente; 49 replays no lote. Outra key para a mesma identidade externa produz conflito sem nova operação. REFUND/ROLLBACK concorrentes e mesma modalidade duplicada produzem uma única reversão. Original e reversão concorrentes concluem sem inversão de locks nos cenários executados.
- Processo encerrado antes de commit, com concorrentes comprovadamente esperando SQL: reserva, wallet, ledger e wager são revertidos; outro processo aplica uma vez e o restante faz replay. Processo encerrado após commit e antes de entregar resposta: ambos os concorrentes retornam replay, preservando saldo original. Não há ACK/publicação nessa prova.
- Ordem inversa: reversão adquire wallet antes da original e confirma PENDING_REFERENCE; a original que aguardava o lock confirma depois. Replay da reversão preserva a resposta pendente original sem executar um worker implícito ou gerar crédito.
- Em todos os cenários financeiros, reconciliação pelo ledger confere saldo, versão, contagens, valores/direção dos lançamentos e estados/idempotência. Regressão de Unicode confirma que surrogate inválido não pode selecionar a wallet de U+FFFD.

Revisão independente identificou colapso de identidades Unicode pelo driver UTF-8. Regressões foram observadas falhando antes da correção; aplicação agora rejeita surrogates isolados em todos os textos antes do hash/SQL e preserva Unicode válido. Revisor confirmou a correção em unidade e PostgreSQL; nenhum outro defeito acionável encontrado.

Validação final em 2026-10-28:

| Comando / verificação                  | Resultado                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                    | Passou                                                                                                                        |
| `bun run lint`                         | Passou; arquitetura sem violações, 45 módulos e 131 dependências                                                              |
| `bun run format:check`                 | Passou                                                                                                                        |
| `bun run test`                         | **248 passaram, 0 falharam, 1772 asserções, 12 arquivos**, incluindo 21 testes de arquitetura positivos/negativos             |
| Novas suítes da Task 06                | 33 testes isolados, 4 de portas SQL e 32 de processamento SQL/distribuído                                                     |
| `bun run build`                        | Passou                                                                                                                        |
| Documentação e integridade do checkout | Links relativos conferidos; `git diff --check` passou; enunciado, migration inicial, dependências e regras strict preservados |

PIDs da execução final, registrados pelos filhos e correlacionados às esperas SQL:

| Cenário               | Processos e resultado                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| 50 duplicatas         | 3348 segurou commit (1 aplicação/16 replays); 2672 esperou e fez 17 replays; 30504 esperou e fez 16 replays |
| Rollback e 100/80/80  | 27392 reverteu; 29900 confirmou 80.00; 14492 rejeitou por insuficiência; saldo 20.00/versão 2               |
| Crash antes do commit | 29704 encerrado no sinal before-commit; 3256 aplicou; 5456 fez replay                                       |
| Crash após commit     | 13596 encerrado no sinal committed-before-response; 30432 e 30364 fizeram replay                            |

Todos os containers/volumes descartáveis da validação foram encerrados/removidos pelo harness. Nenhuma imagem da aplicação foi reconstruída; build TypeScript e inicialização Nest/HTTP real passaram na suíte. Não foram executados SQS/LocalStack ou testes de publicação, que não pertencem a esta etapa.

Durante a Task 06, Graphify estava indisponível: consultas com símbolos reais falharam com `command not found: graphify` mesmo após incluir `.local/bin` no PATH. Naquela execução o índice não foi atualizado e a exploração usou busca restrita. A [recuperação posterior autorizada](tooling-recovery-report.md#graphify) instalou o CLI e validou construção, query, explain e path; não altera retroativamente as evidências da Task 06.

### Arquivos da Task 06

Criados: `src/modules/wagering/application/canonical-wager.ts`, `src/modules/wagering/application/process-wager.use-case.ts`, `src/modules/wagering/public/process-wager.ts`, `src/modules/wagering/adapters/persistence/mappers.ts`, `src/modules/wagering/adapters/persistence/mikro-orm-idempotency.repository.ts`, `src/bootstrap/wagering.ts`, `src/platform/persistence/migrations/Migration202610280002.ts`; três suítes `test/process-wager.test.ts`, `test/wagering-persistence.test.ts`, `test/process-wager-persistence.test.ts`; dois helpers `test/support/wager-child.ts`, `test/support/wager-process.ts`; [plano de checkpoints](../plans/2026-10-28-process-wager.md).

Evoluídos: porta `src/modules/wagering/public/persistence.ts`, exports `public/index.ts`, adapter Wagering existente, composição `src/bootstrap/persistence.ts`, registro de migrations `src/platform/persistence/config.ts`, expectativas de integridade em `test/persistence.test.ts`; este documento, Wagering, referências de Financial, requisitos, arquitetura e README. Domínio Wagering e seus testes preexistentes foram preservados. Nenhuma alteração em dependências, configuração strict, migration inicial ou enunciado.

Limites: nenhuma garantia de entrega exactly-once; sem publicação, ACK, SQS, retry automático, TTL, worker, endpoints ou classificação genérica em FAILED. Testes demonstram os cenários descritos, não ausência universal de deadlocks sob quaisquer clientes SQL que ignorem a ordem contratada.
