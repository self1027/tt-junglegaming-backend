> HISTORICAL: registro da etapa indicada. Estado atual em [docs/index](../../index.md).

# ProcessWager — plano e registro de execução

**Objetivo:** entregar a Task 06, independente de transporte, preservando o domínio existente e uma única transação SQL.

**Arquitetura:** aplicação Wagering coordena Financial público e UnitOfWork; adapters usam a mesma TransactionSession. Sem dependências novas.

**Spec:** políticas aprovadas e contrato em [Wagering](../../domain/wagering.md); fonte primária [challenge](../../challenge.md), imutável.

## Restrições e decisões de execução

- Preservar alterações preexistentes do núcleo Wagering. Trabalhar no checkout/main atual conforme política local de entrega; sem criar worktree, commits ou movimentar trabalho alheio.
- Executar A–E nesta sessão, conforme autorização da tarefa, sem gates adicionais de aprovação de plano.
- Graphify consultado com símbolos conhecidos: Bun 1.4.4 disponível em `.bun/bin`; CLI graphify não localizado no PATH nem em `.local/bin`. Exploração restrita dos módulos, schema e harness existentes.
- Revisar especialmente: identidades com delimitadores/Unicode, mutação do command durante await, replay após outra operação, referências entre wallets e corrida original/reversão.

## Checkpoints

- [x] A: ler fontes e instruções; conferir schema; registrar contrato, locks, códigos e políticas em Wagering antes de persistência.
- [x] B: testes SQL de reidratação/estados/reserva/constraints; portas em `public/persistence.ts`, mapper e adapters em Wagering; extensão em `bootstrap/persistence.ts`; migration adicional e registro em `platform/persistence/config.ts`.
- [x] C: testes isolados em `test/process-wager.test.ts`; entrada/resultado em `public/process-wager.ts`; canonicalização e coordenador em `application/`; composição concreta em bootstrap.
- [x] D: `test/process-wager-persistence.test.ts` e filhos em `test/support/`; PostgreSQL real, falhas SQL e três processos/pools independentes; reconciliação e interrupção antes/depois do commit.
- [x] E: revisão independente; corrigir achados; typecheck, lint (inclui arquitetura), format:check, test (inclui negativos de arquitetura), build; conferir links e diff; registrar evidências e limites.

## Aceitação

Operações corretas por estado; rejeições e pendências sem saldo/versão/ledger; replay histórico; reservas revertidas com rollback; concorrência 100/80/80; mesma key e identidade externa sem duplicação; reversões concorrentes sem crédito cumulativo; wallets distintas paralelas; ledger reconciliado. Erros técnicos propagam, sem FAILED automático/retry interno. Nenhum HTTP/SQS/Inbox/Outbox/worker.

## Registro de revisão

Revisor independente reproduziu colisão de identidade entre surrogate isolado e U+FFFD no PostgreSQL. Correção na canonicalização antes de awaits/SQL; sete regressões unitárias de campos inválidos, preservação de Unicode válido e regressão SQL observadas RED → GREEN. Revisor confirmou 31 testes unitários e o cenário SQL sem efeitos; nenhum outro defeito acionável. Aceitação final inclui também vetor SHA-256 independente, IN_PROGRESS distinto de resposta pendente, 50 duplicatas em três pools e ordem inversa entre reversão/original. Evidências finais em [persistência](../reports/task06-process-wager-report.md).

Validação final: typecheck/lint/format:check/build aprovados; `bun run test`: 248 passaram, 0 falharam, 1772 asserções em 12 arquivos. Inclui 21 testes de arquitetura. Graphify indisponível, sem atualização do índice. Sem alterações em challenge, migration inicial ou regras strict; sem commits/push nesta execução.
