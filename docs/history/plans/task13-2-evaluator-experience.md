# Task 13.2: experiência de avaliação

Origem: `fix/reversal-re03-conformance`, commit `7448fd4`. Checkout e index
limpos na inspeção inicial. Trabalho em `feat/evaluator-experience`, preservando
o histórico. Escopo e execução autorizados pela solicitação da Task 13.2;
push depende de autorização e merge não está autorizado.

## Investigação

- Migrations: CLI MikroORM em `db:migrate`, seis classes explícitas em
  `persistenceConfig`, execução transacional e tabela de controle. Runtime não
  contém CLI. Nenhuma migration histórica será editada.
- Filas: `provision-sqs.ts` cria comandos/DLQ/eventos FIFO, configura redrive e
  permissão de origem. CreateQueue com atributos iguais pode ser repetido.
- Rede: PostgreSQL em `postgres:5432`, SQS em `localstack:4566`, estratégia
  dinâmica do LocalStack. Somente API exposta em loopback.
- Health atual: PostgreSQL/LocalStack no Compose; API separa live de ready.
  Workers emitem consumer_ready/publisher_ready/pending_ready após checks reais.
- Imagem: quatro entrypoints JS compilados, usuário bun, comandos exec sem shell;
  os runners tratam SIGTERM. Migrations/provisionamento são explícitos.
- Harnesses `test/support/postgres.ts` e `sqs.ts` usam o Compose original,
  portas dinâmicas e teardown próprio; não serão alterados.
- `documentation-examples.test.ts` extrai o primeiro bloco sh de
  `docs/contracts/http.md`, o JSON SQS e comandos awslocal de consumer.md.
  `documentation.test.ts` verifica links, âncoras, scripts e exemplos.
- Graphify local disponível: consultas por Docker/migrations e por
  documentation-examples/provisionSqs localizaram os arquivos conferidos.
  A consulta ampla truncou vizinhos; buscas restritas completaram a navegação.

## Plano e aceite

- [x] Docker: `Dockerfile`, `compose.demo.yaml`, ferramentas em `docker/`.
      Target de migrations separado; runtime compartilhado; jobs one-shot após
      dependências saudáveis. Wrapper técnico observa startup JSON dos workers,
      encaminha sinais e expõe marcador local de saúde, sem regra financeira.
      Aceite: up real, falha de bootstrap visível, repetição/restart/SIGTERM.
- [x] Smoke: `docker/smoke.ts` e verificações auxiliares, incluídos no typecheck.
      HTTP concorrente 100/80/80, replay/conflito, SQS/Inbox/Outbox/eventos e REFUND
      antes da BET. Identidades únicas, polling com prazo, SQL somente leitura para
      evidência. Aceite: duas execuções seguidas e negativas controladas.
- [ ] CI: `.github/workflows/ci.yml`, jobs independentes quality/integration/
      docker-smoke, Bun 1.4.4, frozen lockfile, Docker real, logs e cleanup always.
      Aceite remoto somente com execução verde no commit publicado.
- [x] Documentação: README curto, `docs/quickstart.md`, prosa de ARCHITECTURE,
      atualização mínima de referências ao setup. Humanizer aplicado sem mudar
      contratos, exemplos executáveis, requisitos ou relatórios anteriores.
- [x] Final: checks estáticos/build, suíte completa, stack limpa com projeto
      descartável próprio, smoke repetido, revisão adversarial independente,
      diff/check de segredos e integridade das migrations/requisitos.
- [ ] Commits coesos, publicação autorizada, PR para main e CI observado.

## Riscos e dependências

Docker deve estar disponível com imagens Linux e recursos para PostgreSQL/
LocalStack. CI recebe até 30 minutos para integração, sem mudar timeouts internos.
Volumes existentes não serão removidos. A limpeza com volumes limita-se a projetos
descartáveis identificados para validação. LocalStack perde mensagens ao ser
recriado; o banco persiste e eventos PUBLISHED não são republicados por isso.
O wrapper confirma startup e existência do processo, não progresso contínuo;
o smoke confirma trabalho real. Falhas de domínio exigem reprodução/documentação
e autorização antes de alteração financeira.

## Estado da entrega

Validação local concluída; CI configurado. Publicação, CI remoto e PR aguardam
autorização de push. Evidências no [relatório](../reports/task13-2-evaluator-experience-report.md).
