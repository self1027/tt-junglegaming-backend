# Executar e inspecionar a demonstração

## Pré-requisitos

Git e Docker Engine/Desktop com Compose v2, daemon ativo e containers Linux.
Reserve a porta 3000. Os comandos abaixo funcionam em Bash e PowerShell e não
dependem de `.env`, Bun, Node.js ou AWS CLI instalados no host.

## Startup

No checkout, execute:

```sh
docker compose -f compose.demo.yaml up -d --build --wait
docker compose -f compose.demo.yaml ps -a
```

`migrate` e `provision-sqs` devem terminar com código zero; os seis serviços
contínuos devem estar saudáveis. A primeira execução baixa imagens e compila.
Pode repetir o comando: MikroORM aplica apenas migrations pendentes e o
provisionamento preserva filas existentes com os mesmos atributos.

`compose.demo.yaml` é independente do Compose usado para desenvolvimento/testes.
Banco e SQS ficam na rede interna; só a API é publicada em loopback. Para trocar
a porta, defina `DEMO_PORT` no ambiente do terminal antes de subir a stack.

## Smoke

```sh
docker compose -f compose.demo.yaml run --rm smoke
```

O processo termina com zero somente depois de verificar 100/80/80, replay,
conflito, duas entregas SQS da mesma mensagem, reconciliação e eventos publicados.
Também confirma PENDING_REFERENCE e sua resolução pelo worker. Ao final a wallet
do cenário tem `25.00 BRL`: os `20.00` iniciais recebem WIN de `5.00`, e BET/REFUND
de `3.00` se compensam. São cinco lançamentos e dez eventos, sem contar abertura
como evento Wagering. IDs relevantes aparecem na saída.
Ele usa a stack já iniciada pelo comando de startup, sem subir ou recriar serviços.

Pode executar novamente. O smoke cria dados novos e não limpa tabelas. Ele
consome e confirma somente eventos da wallet que criou; mensagens de outras
wallets recebem visibilidade temporária e são liberadas ao terminar. Execute
um smoke por vez nesta fila de demonstração.

Polling tem prazo de 45 segundos por etapa, com timeouts de rede e SQL. Erros
saem com código não zero e indicam o check. Logs dos serviços ajudam a localizar
a falha; o sucesso de SendMessage sozinho não conta como processamento.

## Health e logs

```sh
docker compose -f compose.demo.yaml exec api bun -e "console.log(await (await fetch('http://127.0.0.1:3000/health/ready')).json())"
docker compose -f compose.demo.yaml logs --tail=30 api consumer publisher pending-worker
```

`/health/live` verifica somente o processo HTTP. `/health/ready` verifica
PostgreSQL e filas de comandos/DLQ, incluindo FIFO/redrive/permissão.
O healthcheck dos workers observa o diagnóstico JSON de startup depois dos checks
reais e confirma que o processo ainda existe. Não mede backlog, progresso contínuo
ou disponibilidade posterior das dependências. O smoke verifica trabalho real
dos três workers. O wrapper Docker encaminha SIGTERM ao processo compilado;
Compose concede 40 segundos para o shutdown configurado de 30 segundos.
Na demo, o consumer usa long polling de 1 segundo para limitar requests antigos
que o LocalStack mantém após reinícios; a configuração geral continua em 20 segundos.

## Suíte completa

O [CI](https://github.com/self1027/tt-junglegaming-backend/actions/workflows/ci.yml)
executa checks estáticos/build e a suíte completa em jobs independentes.
Para reproduzir a suíte localmente, instale Bun 1.4.4, mantenha Docker ativo e
execute:

```sh
bun install --frozen-lockfile
bun run test
```

Os harnesses criam seus próprios projetos, portas e volumes descartáveis.
Não usam nem apagam o banco da demo. Exemplos documentados exigem Bash/curl
(Git Bash no Windows). A suíte pode levar vários minutos; veja
[seleção de testes e limites](testing/strategy.md).

## Shutdown

```sh
docker compose -f compose.demo.yaml down
```

Preserva o volume PostgreSQL. `down --volumes` descarta o histórico da demo.
LocalStack não persiste filas: após `down`, o próximo startup as recria vazias.
O banco conserva Outbox PUBLISHED; isso não provoca republicação automática.
`restart api consumer publisher pending-worker` no mesmo Compose reinicia os
processos sem recriar banco ou filas.

## Troubleshooting

| Sintoma                               | Ação                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Docker não conecta                    | Inicie o daemon/Desktop e habilite containers Linux.                                                                 |
| Porta 3000 ocupada                    | Defina `DEMO_PORT` com uma porta livre e repita o startup.                                                           |
| Inicialização falha                   | Consulte `logs migrate provision-sqs` no mesmo Compose. Não execute rollback financeiro para reparar setup.          |
| Health não fica saudável              | Consulte `ps -a` e logs do serviço. Confira recursos do Docker e SQL/SQS, sem remover volumes para esconder a falha. |
| Smoke expira                          | Inspecione consumer/publisher/pending-worker e `/health/ready`; mantenha apenas um smoke ativo.                      |
| Filas sumiram após recriar LocalStack | Repita o startup; mensagens antigas foram perdidas pelo emulador.                                                    |

Configuração por variável, desenvolvimento pelo checkout e operações avançadas
estão no [guia local](operations/local-development.md).
