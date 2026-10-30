> HISTORICAL: registro da etapa indicada. Estado atual em [docs/index](../../index.md).

# Task 07 — Transactional Outbox

Pedido de implementação: Task 07 fornecida pelo usuário. Execução local em
checkpoints; preservar alterações preexistentes da Task 06 e o enunciado.

## A — Contratos (decisões antes dos adapters)

- Quatro classes concretas v1 derivadas de IntegrationEvent; união discriminada
  pública de Wagering. Sem dependências de infraestrutura nas camadas internas.
- Envelope completo no JSONB: eventId, eventType, version, aggregateId,
  correlationId, causationId opcional, occurredAt ISO UTC e data.
- UUID aleatório criado uma vez por fato; aggregateId = transactionId para
  eventos Wagering, walletId para WalletBalanceChanged. Correlação padrão =
  transactionId; entrada direta não inventa causationId. Factories permitem
  contexto explícito para futura transição causada por evento.
- Dados Wagering: identidade interna/externa, provider, player, wallet, kind,
  money e status; processado inclui referência interna se resolvida, rejeitado
  inclui failureCode, pendente inclui referência externa ausente.
- WalletBalanceChanged mantém exatamente os campos do exemplo do desafio.
- PENDING com referência encontrada não emite evento. FAILED não é gerado pelo
  processador. Replay/conflitos não constroem eventos.
- Datas defensivas, cópias congeladas dos dados e validação antes da persistência;
  dinheiro canônico com duas casas, sem number/bigint no JSON.

## B — Porta e persistência

- OutboxRepository.append(readonly WagerIntegrationEvent[]) no contrato público;
  adapter do módulo usa OutboxMessageRow e TransactionSession existentes.
  Platform não importa módulos. Bootstrap compõe todos na mesma sessão.
- INSERT imediato; defaults SQL PENDING/0/created_at/next_attempt_at; published_at
  nulo. Sem commit, retry, update, publisher ou migration nova sem necessidade.
- Testar INSERT, unicidade, contexto encerrado e rollback real.

## C — Processador

- Construir eventos após decisão/efeitos e antes de idempotency.complete.
- Processed + saldo quando houve BalanceChange; LOSS somente Processed;
  Rejected e PendingReference isolados. Erros propagam ao UnitOfWork.
- Ampliar testes unitários existentes para matriz, replay e falha de append.

## D — Resiliência

- Ampliar inspect do harness SQL para conferir eventos por operação/ledger.
- Reaproveitar três processos, 50 duplicatas, wallets distintas e crash nos
  sinais antes/depois do commit. Conferir visibilidade antes de liberar retries,
  IDs/timestamps preservados e leitura por nova conexão/processo.
- Injetar falha no segundo evento e falha SQL após append; conferir rollback de
  todos os participantes e retry posterior. Duplicata de eventId reverte lote.

## E — Revisão e entrega

- Revisão independente dos arquivos da Task 07, corrigir achados com testes.
- Executar typecheck, lint (inclui arquitetura), format:check, test (inclui
  negativos de arquitetura/migrations/PostgreSQL), build, git diff --check.
- Conferir links relativos, atualizar documentos principais e Graphify.
- Relatório final com inventário, contratos, evidências, limites e próxima etapa.

## Registro

- Inicial: Graphify operacional após PATH local; consulta/explain localizaram
  ProcessWagerUseCase, contexto público, bootstrap, modelos e testes existentes.
- Ruling: preservar checkout com Task 06 não commitada em nova branch local,
  sem mover/apagar alterações do usuário nem criar commits misturados.
- Pre-flight: B fornece append ao contexto consumido por C; D usa a mesma
  composição em três processos. Não há alteração nas regras Financial.
- A/B/C/D: concluídos. RED unitário por eventos ausentes; RED SQL por porta não
  composta; GREEN 52 unitários e 36 integrações do processador. Na suíte completa,
  272 passaram/0 falharam, 2.588 asserções, incluindo regressões anteriores.
- E: revisão independente sem achados bloqueantes; typecheck, lint/arquitetura e
  build passaram. Evidências consolidadas no [relatório](../reports/task07-outbox-report.md).
