# Distributed Wagering Processor

Serviço financeiro para o [backend challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge).
Recebe apostas por HTTP e SQS, registra cada movimento em um ledger e publica
os eventos confirmados. PostgreSQL coordena o saldo e a idempotência entre
instâncias, inclusive quando mensagens chegam duplicadas ou fora de ordem.

## Execute com Docker

Requer Git e Docker Engine/Desktop com Compose v2 e containers Linux.
Não precisa instalar Bun, Node.js, PostgreSQL ou AWS CLI no host.

```sh
git clone https://github.com/self1027/tt-junglegaming-backend.git
cd tt-junglegaming-backend
docker compose -f compose.demo.yaml up -d --build --wait
```

O comando compila a imagem, sobe PostgreSQL/LocalStack, aplica migrations e
provisiona as filas antes de iniciar API, consumer, publisher e worker de
referências. Aguarda os healthchecks; a API fica em `http://127.0.0.1:3000`.
As credenciais são exemplos locais, sem `.env` obrigatório.

## Teste a solução

```sh
docker compose -f compose.demo.yaml run --rm smoke
```

O smoke cria uma wallet com `100.00 BRL` e envia duas BETs de `80.00` em paralelo:
uma processa, a outra é rejeitada e o saldo fica em `20.00`, com um único débito.
Depois confere replay e conflito de payload, entrega duplicada por SQS, eventos
da Outbox e resolução de REFUND enviado antes da BET.

```text
PASS  Concurrent bets: 100/80/80; PROCESSED …, REJECTED …
PASS  Ledger and reconciliation: 20.00 BRL, one debit
PASS  Idempotent replay and divergent payload conflict
PASS  SQS processing: …
PASS  Pending reference resolution: …
PASS  Transactional Outbox: 10 matching eventIds received; …

ALL CHECKS PASSED
```

Cada execução usa identidades novas e consulta respostas, ledger, Inbox/Outbox e
eventos reais. Pode repetir sem apagar o banco. O [quickstart](docs/quickstart.md)
traz health, logs e solução de problemas.

## O que foi implementado

- Dinheiro exato em centavos (`bigint`), com strings decimais nos contratos.
- Lock pessimista por wallet e constraints SQL para concorrência entre instâncias.
- Idempotência persistente, conflito de payload e replay do saldo histórico.
- Ledger imutável e reconciliação por snapshot, sem correção silenciosa.
- Inbox no mesmo commit financeiro; ACK depois do commit. Outbox transacional.
- Recuperação por redelivery e claims com lease/token e fencing.
- Reversões integrais e worker para referências fora de ordem, conforme a
  [política RE-03](docs/domain/wagering.md#políticas-e-reversões).

## Testes e CI

O [GitHub Actions](https://github.com/self1027/tt-junglegaming-backend/actions/workflows/ci.yml)
separa checks estáticos, suíte completa com PostgreSQL/LocalStack reais e smoke
Docker. Consulte a execução do commit para conferir o resultado.

Com Bun **1.4.4** e Docker instalados:

```sh
bun install --frozen-lockfile
bun run test
```

A suíte cria ambientes descartáveis próprios; inclui processos concorrentes,
falhas, recuperação e exemplos executáveis Bash/curl. A primeira execução baixa
imagens e pode levar vários minutos. Veja a [estratégia de testes](docs/testing/strategy.md).

## Arquitetura e limitações

Monólito modular hexagonal com quatro processos independentes. Financial mantém
saldo/ledger; Wagering coordena operações; adapters implementam HTTP, SQL e SQS.
Bun, TypeScript strict, NestJS e MikroORM compõem a aplicação.

Eventos têm entrega at-least-once: consumidores precisam deduplicar por `eventId`.
Autenticação foi omitida conforme o desafio, com ponto de extensão para IdP.
Métricas são JSON, sem backend agregado. A demo mantém PostgreSQL em volume;
recriar LocalStack perde suas mensagens e não republica eventos já marcados como
PUBLISHED. É um ambiente local, sem backup/failover ou validação de IAM na AWS.

[Arquitetura e decisões](ARCHITECTURE.md) · [Requisitos e evidências](docs/requirements.md) ·
[Contratos e guias técnicos](docs/index.md) · [Desenvolvimento local](docs/operations/local-development.md)

## Parar a demonstração

```sh
docker compose -f compose.demo.yaml down
```

O volume PostgreSQL e seu histórico são preservados. `down --volumes` apaga os
dados da demo; use somente se quiser descartá-los.
