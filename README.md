# Distributed Wagering Processor

API NestJS para um monólito modular hexagonal, com fundação PostgreSQL/MikroORM. Única rota: `GET /health/live`, com HTTP 200 e `{"status":"ok"}`. Liveness verifica apenas o processo HTTP.

Requer Bun **1.4.4** no PATH e Docker com Compose para PostgreSQL local e testes de integração. Node, npm, pnpm, Yarn e Nest CLI não são necessários para os comandos do projeto. Dependências diretas têm versões exatas e `bun.lock` deve ser versionado.

```sh
bun install --frozen-lockfile
# Copie .env.example para .env (PowerShell: Copy-Item .env.example .env).
docker compose --project-name dwp up -d --wait
bun run db:migrate
bun run dev
```

`PORT` é opcional (padrão `3000`, inteiro entre 1 e 65535). Bun e Compose carregam `.env` local; use [.env.example](.env.example) como referência e credenciais apenas de desenvolvimento. O servidor escuta em `0.0.0.0` e abre conexão PostgreSQL no startup. Nenhuma migration é executada automaticamente.

`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER` e `POSTGRES_PASSWORD` são obrigatórias na aplicação/CLI; `POSTGRES_POOL_MAX` é opcional (10). Compose publica a porta configurada somente em 127.0.0.1, com volume persistente e healthcheck. Não reutilize o banco da aplicação para testes: a suíte cria projetos Compose e volumes descartáveis próprios, em portas dinâmicas.

| Comando                | Função                                                    |
| ---------------------- | --------------------------------------------------------- |
| `bun run dev`          | Bun com watch sobre o TypeScript                          |
| `bun run build`        | Limpa dist e executa tsc com Bun                          |
| `bun run start`        | Bun executando dist/main.api.js                           |
| `bun run typecheck`    | TypeScript sem emissão, incluindo testes e build.ts       |
| `bun run lint`         | ESLint sem warnings e análise arquitetural                |
| `bun run lint:fix`     | Correções do ESLint e análise arquitetural                |
| `bun run architecture` | Grafo de dependências da aplicação                        |
| `bun run format:check` | Verificação do Prettier                                   |
| `bun run format`       | Formatação do Prettier                                    |
| `bun run test`         | Bun Test, PostgreSQL real, HTTP e testes negativos        |
| `bun run db:migrate`   | Aplica migrations versionadas                             |
| `bun run db:rollback`  | Reverte a última migration; recusa ledger com lançamentos |
| `bun run db:status`    | Lista migrations executadas e pendentes                   |

Produção local: `bun run build` seguido de `bun run start`.

Schema físico, decisões de precisão/referências/OPENING, integridade e reversibilidade estão em [docs/persistence.md](docs/persistence.md). Testes de persistência isolados: `bun test test/persistence.test.ts`. Eles executam CLI up/status/down/up, constraints, commit/rollback, identity maps e locks por wallet entre processos Bun independentes; requerem PostgreSQL real em container e não são substituídos por mocks. A primeira execução pode baixar a imagem PostgreSQL.

`docker compose --project-name dwp down` encerra o banco preservando o volume. Trocar credenciais em `.env` não altera um volume PostgreSQL já inicializado; alinhe as credenciais do banco existente. `db:rollback` é destinado ao banco descartável sem histórico, não à exclusão de lançamentos confirmados.

Para navegar pelo código, consulte o grafo Graphify antes de explorar arquivos: `bun run graph:query "createApi ApiModule"`. Gere o primeiro índice com `bun run graph:build` e atualize após mudanças de código com `bun run graph:update`. Instalação da ferramenta externa, demais consultas e limites de cobertura estão em [docs/tooling/graphify.md](docs/tooling/graphify.md). O guia do agente está em [AGENTS.md](AGENTS.md).

```sh
docker build -t distributed-wagering-processor .
docker run --rm --name dwp-api --network dwp_default -p 3000:3000 --env-file .env -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 distributed-wagering-processor
curl http://localhost:3000/health/live
```

Imagem Bun fixada por versão e digest, estágios separados para build/dependências de produção, instalação com `--frozen-lockfile`, execução como usuário `bun`. O exemplo usa PostgreSQL iniciado no projeto Compose `dwp`; aplique migrations pelo checkout com dependências completas antes de iniciar a API. CLI não pertence à imagem de produção. Ao atualizar Bun, atualizar packageManager, engines e imagem/digest juntos.

```text
src/
  main.api.ts
  bootstrap/                    # módulo Nest e fábrica HTTP
  modules/
    financial/{public,domain,application,adapters}/
    wagering/{public,domain,application,adapters}/
  platform/
    messaging/
    persistence/
    observability/              # controller de liveness
test/                           # integração e fronteiras
```

Pastas vazias são preservadas por `.gitkeep`. Persistência técnica das seis tabelas, núcleo financeiro (Money, Wallet e WalletLedgerEntry), portas, mappers, adapters e UnitOfWork estão implementados. APIs, invariantes e factory de abertura versão 1 estão em [Financial](docs/domain/financial.md); contrato transacional/locks em [persistência](docs/persistence.md#integração-financeira-e-unitofwork). Casos de uso, endpoints financeiros, apostas, processamento de mensagens e workers continuam futuros.

Integração dos adapters: `bun test test/financial-persistence.test.ts`. Usa outro PostgreSQL descartável e testa precisão, ledger, commit/rollback, contextos/pool e locks com três processos Bun independentes. Não substitui os cenários futuros de idempotência, SQS ou recuperação de workers.

Unidade financeira sem PostgreSQL/Nest/Docker: `bun test test/money.test.ts test/wallet.test.ts test/wallet-ledger-entry.test.ts`.

`tsconfig.json` habilita todas as verificações strict solicitadas, incluindo índices possivelmente ausentes, propriedades opcionais exatas, overrides explícitos e verificações de código não usado. Decorators legados e `emitDecoratorMetadata` preservam a integração Nest. O build usa tsc, executado por Bun, para emitir os metadados sem depender de um bundler; Bun executa tanto os fontes em desenvolvimento quanto o JavaScript compilado. Testes e build.ts pertencem ao mesmo projeto tipado; arquivos JS de configuração são incluídos para resolução, mas recebem somente regras ESLint sem análise de tipos.

ESLint Flat Config combina `@eslint/js` recommended com `strictTypeChecked`, `stylisticTypeChecked` e `projectService: true` para TypeScript. Os presets já cobrem `no-explicit-any`, regras `no-unsafe-*`, promises e `await-thenable`. Regras adicionais exigem retornos explícitos, imports de tipos, condições booleanas estritas e switches exaustivos. Apenas módulos decorados em `bootstrap/**/*.module.ts` recebem `allowWithDecorator` em `no-extraneous-class`: classes vazias decoradas são a configuração declarativa exigida pelo Nest, sem relaxar a regra no restante do código.

`@ts-ignore` e `@ts-nocheck` são proibidos. `@ts-expect-error` exige descrição de pelo menos dez caracteres e o próprio TypeScript rejeita diretivas que não correspondem a um erro. A revisão deve verificar a justificativa. Supressões inline de ESLint são inteiramente proibidas (`noInlineConfig`); uma exceção futura deve ser explícita, localizada e justificada na configuração versionada. Não há desativações globais para contornar falhas.

Prettier é o único responsável pela formatação: tabs com largura visual 4, aspas simples, ponto e vírgula, arrow functions sem parênteses quando possível e trailing commas em todos os lugares suportados. `eslint-config-prettier` é aplicado por último.

As fronteiras locais usam ESLint: domain/application/public não importam pacotes externos; `@Module` fica em bootstrap; controllers rejeitam decisões, loops, atribuições e cálculos. Essa política inicial mantém as camadas internas independentes de frameworks e implementações externas.

O dependency-cruiser complementa o ESLint com resolução de caminhos e análise global do grafo, necessária para ciclos e dependências transitivas através de arquivos intermediários. É executado dentro de `lint`, também para imports de tipos, imports dinâmicos literais e reexports:

- domain depende apenas de domain/public;
- application depende apenas de application/domain/public;
- public expõe contratos e pode depender somente de public/domain;
- financial nunca depende de wagering, nem de seu public;
- outros módulos só acessam financial/wagering por public;
- módulos e platform não importam bootstrap; platform não depende dos módulos;
- ciclos, imports não resolvidos e dependências de desenvolvimento em produção falham;
- implementações são compostas em bootstrap.

`test/architecture.test.ts` constrói pequenos grafos isolados e exige código de saída 1 **e o nome da regra esperada** para cada violação. Inclui controles positivos para application → domain e wagering → financial/public. Os fixtures são excluídos de lint/typecheck e removidos após os testes. Os testes ESLint usam a configuração real para rejeitar lógica em controller e composição fora de bootstrap.

Bun Test foi escolhido sem Jest ou adaptadores adicionais: a compatibilidade é verificada por inicialização real de `@nestjs/testing` e requisições HTTP via fetch em porta efêmera, com fechamento da aplicação após os testes. Nenhuma integração de mocking do Jest é presumida.

Limites: verificações estáticas não provam ausência semântica de regra de negócio em um método. Controllers e contratos públicos ainda precisam de revisão humana. Imports dinâmicos calculados são proibidos pelo ESLint para manter o grafo verificável; o decorator Module deve manter seu nome, e tanto `@Module` quanto `@Nest.Module` são verificados. Ao criar novos módulos, ampliar a lista de módulos em `.dependency-cruiser.cjs` e os testes correspondentes. Próximos passos de domínio e infraestrutura dependem de definições futuras; não fazem parte deste bootstrap.

Referências técnicas: [TypeScript decorators](https://www.typescriptlang.org/docs/handbook/decorators), [typescript-eslint Project Service](https://typescript-eslint.io/blog/project-service/) e [dependency-cruiser rules](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md).
