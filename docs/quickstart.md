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

`migrate` e `provision-sqs` devem terminar com código zero; os onze serviços
contínuos devem estar saudáveis. A primeira execução baixa imagens e compila.
Pode repetir o comando: MikroORM aplica apenas migrations pendentes e o
provisionamento preserva filas existentes com os mesmos atributos.

`compose.demo.yaml` é independente do Compose usado para desenvolvimento/testes.
Banco, SQS e APIs ficam na rede interna. Só o Nginx tem porta publicada em
loopback. Para trocar a porta, defina `DEMO_PORT` no terminal antes de subir a stack.

A topologia é fixa. Nginx distribui HTTP entre `api-1`, `api-2` e `api-3`.
A stack também executa
`consumer-1/2`, `publisher-1/2`, `pending-worker`, PostgreSQL e LocalStack. Os dois
publishers enviam os eventos da Outbox; `pending-worker` resolve referências.
Os processos Bun usam a imagem runtime compilada por `api-1`, cada um com seu
pool, healthcheck e ciclo de vida. O job de migrations usa o target da CLI.
Locks por wallet, idempotência, Inbox e claims de Outbox são coordenados no
PostgreSQL compartilhado.

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

Todo HTTP do smoke passa pelo Nginx. O script resolve os endereços das três APIs
e confere o header `X-Demo-Upstream`. As requisições de readiness precisam chegar
às três APIs, e as duas BETs simultâneas precisam chegar a backends diferentes.
Depois do WIN, o script envia 50 replays concorrentes pelas três APIs. Todos devem
retornar o mesmo transactionId e o saldo histórico `20.00`, sem novos débitos ou
eventos, enquanto o saldo atual é `25.00`.
As consultas SQL são somente leitura. A criação e as operações passam pelos
contratos públicos.

Pode executar novamente. O smoke cria dados novos e não limpa tabelas. Ele
consome e confirma somente eventos da wallet que criou; mensagens de outras
wallets recebem visibilidade temporária e são liberadas ao terminar. Execute
um smoke por vez nesta fila de demonstração.

Polling tem prazo de 45 segundos por etapa, com timeouts de rede e SQL. Erros
saem com código não zero e indicam o check. Logs dos serviços ajudam a localizar
a falha; o sucesso de SendMessage sozinho não conta como processamento.

## Carga opcional

Depois do smoke, execute `docker compose -f compose.demo.yaml run --rm load`.
O perfil Quick usa concorrência moderada e para ao atingir a duração ou o teto
de operações. Para uma amostra maior, execute
`docker compose -f compose.demo.yaml run --rm -e LOAD_PROFILE=standard load`.
Os relatórios ficam em `load-results/`, no host. Com Bun instalado,
`bun run test:load` usa o mesmo serviço e coleta também os metadados do host.

Execute somente uma carga ou smoke por vez. O serviço `load` não inicia com
`up`, não recria a stack e preserva o histórico. Parâmetros, interpretação e
limitações estão no [guia de carga](testing/load-test.md).

## Health e logs

```sh
docker compose -f compose.demo.yaml exec nginx wget -S -O - http://127.0.0.1:8080/health/ready
docker compose -f compose.demo.yaml logs --tail=30 nginx api-1 api-2 api-3 consumer-1 consumer-2 publisher-1 publisher-2 pending-worker
```

No gateway, `/health/live` verifica somente o Nginx. `/health/ready` consulta uma
API disponível, que verifica PostgreSQL e filas de comandos/DLQ, incluindo
FIFO/redrive/permissão.
O healthcheck dos workers observa o diagnóstico JSON de startup depois dos checks
reais e confirma que o processo ainda existe. Não mede backlog, progresso contínuo
ou disponibilidade posterior das dependências. O smoke verifica trabalho real
dos workers. O wrapper Docker encaminha SIGTERM ao processo compilado;
Compose concede 40 segundos para o shutdown configurado de 30 segundos.
Na demo, o consumer usa long polling de 1 segundo para limitar requests antigos
que o LocalStack mantém após reinícios; a configuração geral continua em 20 segundos.

O Nginx usa SIGQUIT e até 30 segundos para drenar conexões. Seu upstream
round-robin compartilha estado e acompanha mudanças de IP pelo DNS Docker.
`X-Demo-Upstream` vem do proxy, inclusive em erros, e não altera o JSON da API.
Os logs de acesso são JSON e registram apenas roteamento, status e tempos.
O proxy não usa cache. A conexão tem timeout de 1 segundo e no máximo três
tentativas; POST já encaminhado não é reenviado. Sem backend disponível, falhas
de conexão retornam 503.

## Falha e recuperação de uma API

```sh
docker compose -f compose.demo.yaml stop api-3
docker compose -f compose.demo.yaml exec nginx wget -S -O - http://127.0.0.1:8080/health/ready
docker compose -f compose.demo.yaml up -d --no-deps --force-recreate --wait api-3
docker compose -f compose.demo.yaml run --rm smoke
```

Com `api-3` parada, as outras duas atendem HTTP e readiness. O smoke completo
exige as três APIs e falha enquanto uma estiver fora. Após recriar `api-3`, ele
deve passar sem reiniciar Nginx. Se todas as APIs pararem, readiness retorna 503
e liveness do proxy continua em 200. Com Nginx parado, o smoke falha.

No CI, a API recriada precisa receber outro IP para testar a atualização por DNS.
O workflow também compara os IDs dos containers antes e depois dos dois primeiros
smokes.

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
Para reiniciar os processos sem recriar banco ou filas:

```sh
docker compose -f compose.demo.yaml restart nginx api-1 api-2 api-3 consumer-1 consumer-2 publisher-1 publisher-2 pending-worker
docker compose -f compose.demo.yaml up -d --wait
```

A demo não inclui TLS, Kubernetes, replicação PostgreSQL ou autoscaling.

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
