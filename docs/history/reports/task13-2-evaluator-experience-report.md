# Task 13.2: experiência de avaliação e entrega

Validação local em 30/10/2026, Windows/Docker Desktop com containers Linux,
Bun 1.4.4, Docker 29.8.1 e Compose v5.5.1. Origem `7448fd4` na branch
`fix/reversal-re03-conformance`; trabalho em `feat/evaluator-experience`.

## Alterações

| Arquivos                                           | Resultado                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.demo.yaml`, `Dockerfile`                  | Stack independente, runtime compartilhado, target de migrations e jobs de inicialização com dependências verificáveis. Somente API publicada em loopback. |
| `docker/smoke.ts`                                  | HTTP concorrente, replay/conflito, SQL somente leitura, entrega duplicada SQS/Inbox, eventos da Outbox e REFUND fora de ordem.                            |
| `docker/worker.ts`, `docker/worker-health.ts`      | Observação dos sinais JSON existentes de startup, marcador/PID de saúde e encaminhamento de SIGTERM ao worker compilado.                                  |
| `docker/json-logger.ts`                            | Preload do logger JSON nativo do Nest somente na API da demo.                                                                                             |
| `tsconfig.json`                                    | Inclui os scripts Docker nas verificações strict.                                                                                                         |
| `.github/workflows/ci.yml`                         | Jobs independentes quality, integration e docker-smoke; actions fixadas por SHA, Bun 1.4.4, logs e limpeza always.                                        |
| `README.md`, `docs/quickstart.md`                  | Entrada curta para avaliação e guia de operação por tarefas.                                                                                              |
| `ARCHITECTURE.md`, índice, guia local e estratégia | Prosa revisada e referências ao bootstrap/demo/CI, preservando decisões e contratos.                                                                      |
| [Plano](../plans/task13-2-evaluator-experience.md) | Investigação, limites, riscos e critérios de aceite.                                                                                                      |

Humanizer foi instalado a partir de
[blader/humanizer](https://github.com/blader/humanizer) e aplicado à prosa.
Nenhum arquivo em `src/`, teste existente, migration, contrato HTTP/SQS/eventos,
enunciado ou matriz de requisitos foi alterado. `compose.yaml`, `.env.example`,
`package.json` e lockfile também foram preservados. A branch mantém todos os
commits anteriores; não houve rebase, substituição do histórico ou merge.

## Comandos e resultados locais

| Verificação executada                                                       | Resultado observado                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                             | Exit 0, sem mudança de dependências.                                                                                                                    |
| `bun run format:check`                                                      | Exit 0.                                                                                                                                                 |
| `bun run typecheck`                                                         | Exit 0.                                                                                                                                                 |
| `bun run lint`                                                              | Exit 0; arquitetura sem violações, 109 módulos/391 dependências.                                                                                        |
| `bun run build`                                                             | Exit 0.                                                                                                                                                 |
| `bun run test`                                                              | Exit 0: **487 pass, 0 fail, 4.768 expect**, 38 arquivos, **466,70 s**.                                                                                  |
| `bun test test/documentation.test.ts`                                       | Exit 0: 4 testes, links/âncoras/frontmatter/comandos/contratos válidos.                                                                                 |
| `docker compose -f compose.demo.yaml up -d --build --wait`                  | Exit 0; seis serviços contínuos saudáveis e dois jobs terminados com zero.                                                                              |
| `docker compose -f compose.demo.yaml run --rm smoke`                        | Exit 0 em execuções consecutivas e depois de reiniciar os processos.                                                                                    |
| Exportação `git archive` sem `.env`/`node_modules`, projeto Docker separado | Build/startup reais e duas execuções consecutivas do smoke com zero.                                                                                    |
| Repetição de `up --wait`                                                    | Sucesso; seis registros de migrations, sem reaplicação financeira. Provisionamento repetido preserva filas.                                             |
| `stop` dos quatro processos e novo `up --wait`                              | Workers encerram com zero; API encerra com 143 após o shutdown Nest reemitir SIGTERM, comportamento confirmado na biblioteca. Smoke posterior aprovado. |
| Logs de aplicação após preload JSON                                         | Todas as linhas verificadas por JSON.parse; startup Nest e diagnósticos operacionais em JSON.                                                           |
| `git diff --check`, inspeção do diff e padrões de credenciais               | Sem erros; somente credenciais locais de exemplo na demo.                                                                                               |

O total de asserções é o resultado desta execução, sem substituir pela baseline
histórica. Os testes de documentação geram asserções conforme links e comandos
presentes; seus documentos foram editados. Nenhum teste foi removido ou enfraquecido.

O smoke verifica saldo `20.00` no cenário 100/80/80 e um débito. Depois de WIN
`5.00`, replay continua retornando o snapshot `20.00`. Duas entregas com dedup IDs
SQS distintos confirmam participação repetida na Inbox, mas um único crédito e
somente os dois eventos esperados. REFUND `3.00` fica pendente antes da BET e o
worker o resolve. Ao final: saldo `25.00`, cinco lançamentos e dez eventIds
recebidos, comparados integralmente aos envelopes Outbox persistidos/PUBLISHED.

## Negativas controladas

- API inacessível: smoke retorna 1 antes de criar wallet.
- Publisher parado: efeitos financeiros/reconciliação são confirmados, mas smoke
  retorna 1 ao expirar o prazo de entrega de eventos. Publisher restaurado depois;
  os fatos financeiros não foram alterados para obter sucesso.
- Job de migration com erro injetado em projeto descartável separado: `up --wait`
  retorna 1 e API/consumer não iniciam. Esse projeto foi removido com seu volume;
  não usou o volume da demo ou do desenvolvedor.
- LocalStack parado: liveness HTTP 200 e readiness 503. Novo startup restaura
  readiness. Nenhum timeout interno, assertion existente ou regra financeira mudou.

## Revisão e navegação

Revisão adversarial independente não encontrou bloqueios no Compose, scripts,
CI ou documentação. A configuração adicional de logger também foi revisada e
exercitada com logs reais. O revisor não declarou execuções Docker próprias.

Graphify foi consultado antes da exploração e atualizado após as mudanças.
Consultas localizaram bootstrap, migrations, provisionamento, harnesses e testes
de documentação. A consulta ampla truncou vizinhos; buscas restritas completaram
as relações. O índice derivado não substituiu conferência das fontes.

## CI, PR e pendências

O workflow está configurado e os SHAs das actions foram conferidos nas tags
oficiais. **CI remoto ainda não verificado**: publicação depende da autorização
de push solicitada pelo usuário. PR ainda não aberto. Não há alegação de checks
verdes, merge ou integração em main.

Depois da autorização: publicar `feat/evaluator-experience`, abrir PR para main,
acompanhar a execução do commit e corrigir falhas comprovadas. O PR inclui o
histórico completo das Tasks anteriores. Merge continua exigindo autorização
explícita separada. A Task só estará concluída após CI verde e PR pronto.

## Limitações e execução pelo avaliador

Health dos workers confirma startup e existência do PID, sem medir progresso
contínuo. O smoke confirma trabalho real. Execute um smoke por vez: ele consome
somente os próprios eventos, devolvendo a visibilidade dos demais. LocalStack
perde mensagens quando recriado; eventos Outbox PUBLISHED não são republicados
automaticamente por isso. PostgreSQL persiste em volume; shutdown normal o preserva.

```sh
git clone https://github.com/self1027/tt-junglegaming-backend.git
cd tt-junglegaming-backend
docker compose -f compose.demo.yaml up -d --build --wait
docker compose -f compose.demo.yaml run --rm smoke
docker compose -f compose.demo.yaml down
```

Esses comandos estarão na main após a integração autorizada. Antes disso, faça
checkout da branch de trabalho publicada. Operação e troubleshooting:
[quickstart](../../quickstart.md).
