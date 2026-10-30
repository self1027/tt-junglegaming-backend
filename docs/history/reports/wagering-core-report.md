# wagering core report

> HISTORICAL: trecho preservado de `docs/domain/wagering.md`; resultados pertencem ao checkpoint original. Estado atual em [docs/index](../../index.md).

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

No checkpoint anterior, consultas Graphify inicial e reformulada (`ProcessedWagerRecord`), geração e atualização falharam por ausência do executável; o índice não foi anunciado como atualizado. A busca restrita conferiu os contratos, adapters e migration citados. A [recuperação posterior do tooling](tooling-recovery-report.md#graphify) foi autorizada e validada separadamente; não altera aquelas evidências históricas.
