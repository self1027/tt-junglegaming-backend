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
Nenhum arquivo em `src/`, migration, contrato HTTP/SQS/eventos, enunciado ou matriz
de requisitos foi alterado. Nenhum teste foi removido, ignorado ou enfraquecido.
A consulta de auditoria em `test/process-wager-persistence.test.ts` foi corrigida
conforme diagnóstico abaixo, com as assertions financeiras preservadas.
`compose.yaml`, `.env.example`,
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
| `bun run test` (primeira execução local)                                    | Exit 0: **487 pass, 0 fail, 4.768 expect**, 38 arquivos, **466,70 s**.                                                                                  |
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

O primeiro job de integração Linux terminou com 486 testes aprovados e uma falha:
o teste de crash antes do commit esperava zero eventos da wallet e recebeu 99
eventos anteriores. Um reproducer de compilação de consultas, sem banco, encontrou
perdas intermitentes do predicado JSON no conjunto Bun 1.4.4/MikroORM 7.2.5.
MikroORM representa essas expressões com Symbols registrados em WeakMap; a
investigação independente também reproduziu perda de registros WeakMap/Symbol
fora do ORM. A identidade da wallet não apareceu no log remoto, portanto esse
vínculo específico é uma explicação sustentada pela reprodução, sem traçar uma
query remota individual.

O harness passou a obter IDs por SQL parametrizado e carregar as entidades por
IDs escalares. Preserva todos os campos e as expectativas zero/dois antes/depois
do commit; acrescenta uma assertion da wallet em cada payload retornado. Não usa
mocks para a integração e não altera Money, transações, locks ou adaptadores de
produção. O resultado da regressão posterior está nos checks do commit e na
descrição do PR.

O primeiro smoke no runner Linux revelou uma diferença do Compose v2: vários
serviços com build para a mesma tag geravam labels de imagem diferentes, e
`run smoke` recriava os workers. Reproduzido com Compose v2.40.3, embora o
Compose v5.5.1 local não mostrasse esse comportamento. O runtime passou a ser
construído somente pelo serviço API; os demais serviços reutilizam sua imagem.
O CI compara os IDs dos containers antes/depois dos dois smokes para impedir
regressão de ciclo de vida.

Os logs também sustentam a hipótese de um long poll antigo receber o WIN depois
do encerramento do consumer, deixando a mensagem invisível por 60 segundos,
além do prazo de 45 segundos do smoke. Não identificam diretamente o destinatário
daquele receive. A correção elimina a recriação involuntária, sem ampliar prazos,
alterar URLs compatíveis ou modificar processamento financeiro.
Reinícios explícitos também podem deixar requests antigos no emulador; a demo
limita seu long polling a 1 segundo. Visibilidade de 60 segundos, prazo de 45
segundos do smoke e configurações gerais de produção permanecem iguais.

Revisão adversarial independente não encontrou bloqueios no Compose, scripts,
CI ou documentação. A configuração adicional de logger também foi revisada e
exercitada com logs reais. O revisor não declarou execuções Docker próprias.

Graphify foi consultado antes da exploração e atualizado após as mudanças.
Consultas localizaram bootstrap, migrations, provisionamento, harnesses e testes
de documentação. A consulta ampla truncou vizinhos; buscas restritas completaram
as relações. O índice derivado não substituiu conferência das fontes.

## CI, PR e pendências

Push e abertura do PR foram autorizados após a validação local. A branch foi
publicada e o [PR #1](https://github.com/self1027/tt-junglegaming-backend/pull/1)
reúne o histórico completo das Tasks anteriores com esta entrega, sem conflitos
com main na conferência remota.

Os SHAs das actions foram conferidos nas tags oficiais. O workflow executa em
pull requests e pushes na main; isso evita duplicar a suíte quando uma branch é
publicada e seu PR é aberto. Resultados remotos pertencem aos
[checks do commit no PR](https://github.com/self1027/tt-junglegaming-backend/pull/1/checks)
e à descrição atualizada do PR, que registra a execução acompanhada. Resultados
locais não substituem essa evidência. A Task exige os três jobs concluídos com
sucesso; merge continua pendente de autorização explícita separada.

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
