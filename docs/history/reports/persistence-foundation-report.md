# persistence foundation report

> HISTORICAL: trecho preservado de `docs/persistence.md`; resultados pertencem ao checkpoint original. Estado atual em [docs/index](../../index.md).

## Histórico de evidências da fundação — 2026-10-28

Ambiente: Windows/PowerShell com Bun 1.4.4, Docker Desktop (Engine 29.8.0), containers Linux amd64. `select version()` confirmou PostgreSQL 18.3 (Debian 18.3-1.pgdg12+1). Dependências instaladas por `bun add --exact`, com lockfile; a instalação congelada também passou nos estágios de desenvolvimento e produção do Dockerfile.

| Comando / cenário executado                               | Resultado real                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                                       | Passou                                                                                                                                            |
| `bun run lint`                                            | Passou sem warnings; Dependency Cruiser sem violações                                                                                             |
| `bun run format:check`                                    | Passou                                                                                                                                            |
| `bun run test`                                            | **49 passaram, 0 falharam**, 151 asserções, 4 arquivos; 24 testes de persistência, 2 de configuração/tipo monetário, 2 da API e 21 de arquitetura |
| `bun run build`                                           | Passou, JavaScript emitido em dist                                                                                                                |
| `db:migrate` / `db:status` / `db:rollback` / `db:migrate` | Executados pelo harness contra banco descartável; up/down/up passou, dados descartáveis removidos, nenhuma migration pendente                     |
| Down com ledger confirmado                                | Recusado; lançamento preservado e migration permaneceu aplicada                                                                                   |
| Locks entre processos                                     | Holder PID 17272; mesma wallet PID 4296 recebeu 55P03; outra wallet PID 17008 adquiriu lock; após commit, a primeira ficou disponível             |
| `docker build -t dwp-persistence-check .`                 | Passou com o Dockerfile existente                                                                                                                 |
| API da imagem + PostgreSQL migrado                        | Inicialização real, GET /health/live = 200 e `{"status":"ok"}`; encerrada com SIGTERM                                                             |
| Documentação / diff                                       | Links relativos e âncoras conferidos; `git diff --check` passou; enunciado e configurações ESLint/Dependency Cruiser preservados                  |

Graphify consultado antes da exploração (`createApi ApiModule`, configuração arquitetural), atualizado após mudanças e reconfirmado por `persistenceConfig ExactNumericType WalletRow` e caminho `ApiModule → persistenceConfig`. Os arquivos de configuração CLI e de lock contêm apenas código no topo, sem símbolos próprios extraídos; seus imports foram conferidos diretamente. O índice permanece derivado, não uma prova de integridade.

Todos os recursos Compose da validação foram removidos, incluindo volumes descartáveis; a imagem de teste ficou disponível localmente. Nenhum check solicitado foi omitido. Casos de uso financeiros, SQS e workers continuam fora desta entrega.

## Inventário de arquivos

Criados:

- [compose.yaml](../../../compose.yaml) e este [docs/persistence.md](../../persistence.md).
- [config.ts](../../../src/platform/persistence/config.ts), [mikro-orm.config.ts](../../../src/platform/persistence/mikro-orm.config.ts), [models.ts](../../../src/platform/persistence/models.ts), [exact-numeric.type.ts](../../../src/platform/persistence/exact-numeric.type.ts) e [Migration202610280001.ts](../../../src/platform/persistence/migrations/Migration202610280001.ts).
- [persistence.test.ts](../../../test/persistence.test.ts), [persistence-config.test.ts](../../../test/persistence-config.test.ts), [support/postgres.ts](../../../test/support/postgres.ts) e [support/wallet-lock.ts](../../../test/support/wallet-lock.ts).

Modificados:

- [.env.example](../../../.env.example), [package.json](../../../package.json), [bun.lock](../../../bun.lock) e [api.module.ts](../../../src/bootstrap/api.module.ts).
- [api.test.ts](../../../test/api.test.ts) e [architecture.test.ts](../../../test/architecture.test.ts).
- [ARCHITECTURE.md](../../../ARCHITECTURE.md), [README.md](../../../README.md), [docs/requirements.md](../../requirements.md), [docs/domain/financial.md](../../domain/financial.md), [AGENTS.md](../../../AGENTS.md) e [Persistence AGENTS.md](../../../src/platform/persistence/AGENTS.md).
