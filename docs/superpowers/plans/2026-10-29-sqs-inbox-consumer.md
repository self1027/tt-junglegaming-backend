# Task 09 — plano de execução

Escopo autorizado: entrada SQS FIFO independente sobre ProcessWagerUseCase,
Inbox transacional existente, ACK após commit e recuperação executável.
Sem publisher ou worker de referências. Inicialmente não havia autorização para
commits/push; durante a execução o usuário autorizou explicitamente commit e envio
ao remote, com no máximo 500 linhas alteradas (adições + remoções) por commit,
sem novas perguntas. Entrega permanece na branch da tarefa, sem merge na main.
Fonte imutável: [challenge](../../challenge.md), §§6.5, 8, 10–13.

## Checkpoint 0 — concluído

Checkout limpo; feat/http-api local, origin/feat/http-api e ls-remote apontam
para f214f1f10e316317fb9d7a5bdff76bc04c807743. Branch criada:
feat/sqs-inbox-consumer. Task 08 preservada como ancestral.

## A — contratos e infraestrutura

- Envelope existente, campos desconhecidos rejeitados, validação runtime pelo
  domínio compartilhado. Nenhum número monetário aceito.
- Inbox usa messageId do envelope, consumerName estável `wagering-v1`.
  MessageId nativo, ReceiptHandle, grupo, dedup e receive count são transporte.
- Hash SHA-256 de envelope normalizado com allowlist/ordem explícita, incluindo
  identidades, occurredAt, key, wallet e Money canônico; referência ausente = null.
- Produtores usam walletId como MessageGroupId e identidade estável por envio
  como MessageDeduplicationId. Banco protege também produtores mal agrupados.
- Claims via INSERT ON CONFLICT + FOR UPDATE, sem leases. Ordem global:
  Inbox → idempotência → identidade externa → wallet → referência/histórico.
  Uma mensagem por execução não adquire outra identidade Inbox.
- RECEIVED não é confirmado isoladamente; rollback/crash remove claim novo.
  PROCESSED prova aceite durável também de REJECTED/PENDING_REFERENCE/PENDING.
  Mesmo ID/hash divergente gera conflito, sem ACK; redrive mantém evidência.
- Redrive nativa após 5 recebimentos; mensagens inválidas, conflitos permanentes
  e falhas técnicas sem confirmação nunca são apagadas. Retry com backoff
  limitado por visibility e redrive; receive count é aproximado, não contador SQL.
- Defaults: long poll 20s, visibility 60s, batch 1, concorrência 4,
  duração máxima 120s, shutdown 30s; extensões finitas até duração máxima.
  Cada poller recebe uma mensagem; grupos distintos progridem em paralelo.
  Sem prefetch de sucessoras, para não gastar suas tentativas de redrive.
- Compose com perfil sqs, LocalStack versionado/digest, sem nomes/volumes globais;
  provisionamento explícito por script, nunca no startup de produção.
- Provar Create/Send/Receive/Delete e atributos FIFO/redrive em recurso descartável.

## B — Inbox e unidade transacional

Criar public/inbox.ts e adapter MikroOrmInboxRepository em Wagering, seguindo
Outbox: contratos internos sem SDK/ORM; modelo/sessão técnicos em Platform.
Estender execute com participação opcional da Inbox, mantendo assinatura HTTP.
Duplicata concluída retorna sem execução financeira. Nenhuma transação aninhada.
Testar commit conjunto, falhas SQL em conclusão/Outbox e concorrência de claim.
Reutilizar tabela existente; migration somente se evidência demonstrar necessidade.

## C/D — transporte e operação

Platform encapsula SDK v3, configuração e polling genérico. Adapter Wagering
valida envelope e delega ao caso de uso; bootstrap faz composição e lifecycle.
main.consumer.ts não inicia HTTP. SDK nunca em domain/application/public.
Visibilidade cobre itens recebidos, inclusive os aguardando seu grupo; falha de
extensão interrompe início de novos itens do grupo e deixa redelivery recuperável.
SIGTERM aborta long poll e impede novos trabalhos; limite encerra processo sem
ACK de transações não confirmadas. Fechar SDK/pool. Readiness API usa SELECT 1
e GetQueueAttributes (FIFO, redrive e DLQ), sem receber/apagar mensagens.

## E — evidências reais

Estender harness PostgreSQL isolado e criar LocalStack/filas por execução.
Testes em test/: parser/config/polling; Inbox PostgreSQL; SQS real; três processos
Bun com pools próprios. Barreiras antes do commit e antes de DeleteMessage,
SIGKILL e retomada por outro processo; ACK falho; 50 duplicatas de negócio;
100/80/80; wallets independentes; HTTP ↔ SQS; negócio/referências/poison/DLQ;
readiness sem banco/fila; SIGTERM real. Reconstruir saldo pelo ledger e verificar
Wagering/idempotência/Inbox/Outbox PENDING sem duplicatas.

## F — revisão e conclusão

Revisor independente em leitura procura riscos listados na Task 09; corrigir
defeitos reproduzidos. Checks consolidados: typecheck, lint (inclui arquitetura),
format:check, test completo, build, migrations reais, Docker build/smoke API e
consumer/SIGTERM, links, diff --check, Graphify update/query. Não repetir checks
equivalentes sem mudança ou falha. Relatório final com resultados exatos,
inventário, PIDs, limites e próxima etapa. Atualizar fontes contratuais antes
das instruções/resumos. challenge.md e migrations históricas imutáveis.

## Registro de execução

- Graphify inicial localizou ProcessWagerUseCase, TransactionSession,
  InboxMessageRow, MikroOrmUnitOfWork, composição e readiness. Consulta ampla
  truncada; arquivos dessas relações conferidos diretamente. Configs/fixtures
  sem símbolos são lidos como fontes obrigatórias/fallback dirigido.
- Decisões acima concretizam escolhas delegadas pela Task 09, sem nova regra
  financeira. A assinatura HTTP e seu hash de negócio permanecem compatíveis.
- Dependência consultada no registry: @aws-sdk/client-sqs 3.1159.0.
- Revisão independente encontrou gasto de tentativas de sucessoras por batch e
  readiness aceitando DLQ denyAll. Regressões falharam antes das correções;
  recebimento unitário por poller e validação de RedriveAllowPolicy corrigiram.
  Ruling: batch limitado a 1 — protege sucessoras FIFO — custo de mais chamadas;
  paralelismo permanece pelo limite configurado de pollers e por processos.
- SQS pausado demonstrou timeout insuficiente do request handler SDK; adicionado
  AbortSignal externo com deadline e cancelamento. pg ignorava propriedade solta
  transaction_timeout; configurada via options e consultada no servidor pelo harness.
