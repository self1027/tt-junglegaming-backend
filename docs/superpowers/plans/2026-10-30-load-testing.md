# Plano da Task 14

**Objetivo:** benchmark reproduzível da demo real, sem alteração financeira.

**Arquitetura:** driver Bun em `docker/load/`, HTTP pelo Nginx, comandos pelo
SQS e SQL somente leitura para observação/reconciliação agregada. O comando
host delega ao mesmo serviço tools usado diretamente pelo Docker. A stack
existente não será recriada. Identidades novas preservam o histórico.

**Especificação:** Task 14 fornecida pelo usuário e [desafio §14](../../challenge.md#14-avaliação--100-pontos).

## Restrições

- Não alterar `src/`, migrations, contratos, locks, RE-03 ou garantias financeiras.
- Branch `feat/load-testing`, baseada em `origin/main` atualizado, sem merge/push automático.
- Sem reset de dados, purge de filas, Promises ilimitadas ou metas de RPS.
- Execução restrita à demo local, com opt-in explícito no serviço.
- Falha, timeout, interrupção ou consistência não confirmada impedem PASS.

## Entregas e aceitação

- [ ] `docker/load/core.ts`: parâmetros validados, percentis nearest-rank,
      throughput por conclusões dentro da janela, classificação e lifecycle.
      `test/load-tool.test.ts`: limites, respostas, percentis, timeout, sinais,
      backpressure, relatórios e recusa de PASS sem reconciliação.
- [ ] `docker/load/observer.ts`: SQL read-only, snapshots de backlog, waits,
      deadlocks globais, processamento/Outbox e verificações agregadas de saldo,
      ledger, versões, idempotência e dois fatos por BET confirmada.
- [ ] `docker/load/main.ts`: preparação, warm-up isolado, medição HTTP de wallets
      independentes/hot wallet, comparação hot com metade da concorrência, corrida
      idempotente e replays históricos, SQS limitado por taxa, drenagem e relatório
      JSON/Markdown em `load-results/` ignorado. Metadados e limitações explícitos.
- [ ] `docker/load.ts`, package.json e Compose: entradas equivalentes, serviço
      tools com depends_on vazio, mounts apenas da ferramenta e resultados.
- [ ] Executar Quick, Standard se viável, smoke e regressão completa. Registrar
      comandos, resultados e limitações reais em `docs/testing/load-test.md`;
      atualizar README, estratégia, índice, quickstart e matriz. Aplicar Humanizer.
- [ ] Formatação, typecheck, lint/build, documentação, atualização Graphify,
      revisão independente e commits semânticos.

## Pontos de revisão

1. URL externa, redirect e ambiente herdado: recusar antes de gerar dados.
2. Requisição que cruza o fim da janela: registrar latência, excluir da taxa
   dentro da janela e conferir seu efeito financeiro na drenagem.
3. Abort/timeout: parar produtores, fechar recursos e salvar relatório incompleto.
4. Publicação: PUBLISHED comprova aceite confirmado pelo SDK seguido de marcação
   SQL; não comprova durabilidade downstream. Não consumir eventos de outros testes.
5. SQL agregado: incluir abertura, checar continuidade dos débitos unitários e
   correspondência por transação/evento, sem carregar ledger no driver.

## Registro de decisões

- O pedido já especifica implementação e validações; execução seguirá nesta
  sessão. O checkout estava limpo; a branch solicitada foi criada no workspace.
- Perfis iniciais: Quick 8s/2s warm-up, 6 concorrentes/12 wallets, teto 600
  operações por fase, SQS 10/s; Standard 30s/5s, 12/24, teto 6000, SQS 25/s.
- Carga determinística, sem pseudoaleatoriedade: wallets exclusivas por produtor
  no cenário independente. UUIDs novos isolam execuções.
- SQLSTATE de erros HTTP não é exposto. Relatar indisponibilidade dessa métrica,
  deadlocks globais e amostras de espera; não interpretar espera como erro.
