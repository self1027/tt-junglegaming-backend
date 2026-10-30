# Teste de carga e análise de performance

O benchmark exercita a demonstração real pelo Nginx e pelo SQS. Cada execução
cria identidades próprias e mantém os registros financeiros. Não há mudança em
`src/`, nos locks, na idempotência ou nas configurações dos processos para obter
throughput maior. O diferencial opcional corresponde ao
[§14 do desafio](../challenge.md#14-avaliação--100-pontos).

## Executar

Primeiro siga o [quickstart](../quickstart.md) para iniciar a demo e executar o
smoke. Depois, na raiz do checkout:

```sh
docker compose -f compose.demo.yaml run --rm load
docker compose -f compose.demo.yaml run --rm -e LOAD_PROFILE=standard load
```

Com Bun 1.4.4 instalado, `bun run test:load` executa o mesmo serviço Docker e
acrescenta metadados do host, imagens efetivas e IDs/PIDs dos containers.
Para escolher Standard pelo launcher:

```powershell
$env:LOAD_PROFILE = 'standard'
bun run test:load
Remove-Item Env:LOAD_PROFILE
```

```sh
LOAD_PROFILE=standard bun run test:load
```

Os comandos usam a stack existente. O serviço `load` está no perfil `tools`,
tem `depends_on: {}` e não inicia com `up`. A ferramenta montada do checkout usa
as dependências da imagem runtime. Atualizações do driver não exigem recriar as
APIs ou os workers. Execute uma carga por vez, sem smoke ou outros produtores
concorrentes, para interpretar filas e estatísticas globais do banco.

O destino é fixo: `nginx:8080`, `postgres:5432/wagering_demo` e LocalStack, com
credenciais de demonstração. O serviço fornece o opt-in `LOAD_TARGET=demo`.
Configurações externas são recusadas; nomes DNS devem resolver para endereços
privados da rede Docker. URLs locais usuais do `.env` de desenvolvimento são
aceitas pelo launcher, mas ele sempre executa a demo fixa. Não há flag para
trocar o destino. Redirects HTTP não são seguidos.

JSON com amostras, parâmetros e metadados e Markdown resumido ficam em
`load-results/<runId>.{json,md}`, ignorados pelo Git e pelo build Docker.
O launcher também registra o estado do checkout. No comando Docker direto,
informações exclusivas do host, como os IDs efetivos das imagens, ficam
indisponíveis; o driver registra as referências do Compose e os recursos visíveis
no container. Worktrees cujo `.git` seja um arquivo precisam adaptar o mount
de metadados; as execuções registradas usaram um checkout normal.

Em Linux, o serviço de ferramenta usa root por padrão para escrever no bind mount.
Para gerar arquivos com seu usuário, crie `load-results/` e passe UID/GID:

```sh
mkdir -p load-results
LOAD_UID=$(id -u) LOAD_GID=$(id -g) docker compose -f compose.demo.yaml run --rm load
```

## Cenários e fases

1. Preparação: DNS/readiness das três APIs e abertura das wallets por HTTP.
2. Warm-up: identidades de provider separadas, sem aproveitar suas amostras.
3. Drenagem do warm-up, antes de iniciar a janela de medição.
4. Medição com produtores concorrentes limitados e parada por duração ou teto.
5. Encerramento dos produtores e espera das requisições já iniciadas.
6. Drenagem de operações, Outbox e, no cenário SQS, fila de comandos/DLQ.
7. Reconciliação SQL somente leitura e geração dos relatórios.

| Cenário                             | Operações e objetivo                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A, `independent-wallets`            | BETs de `1.00 BRL`; cada produtor tem uma partição exclusiva de wallets. Mede avanço sem disputa da mesma wallet.                                                 |
| B, `hot-wallet-half` e `hot-wallet` | BETs distintas contra uma wallet, primeiro com metade da concorrência, depois com a concorrência configurada. Mede contenção sem provocar insuficiência de saldo. |
| C, `idempotency`                    | Corrida inicial com a mesma identidade; depois uma BET distinta muda o saldo. A janela mede somente replays que precisam preservar o resultado histórico.         |
| D, `sqs-outbox`                     | Envelopes reais com IDs únicos e grupos por wallet. Limite de envios por segundo, confirmação SQL/Inbox separada do SendMessage e acompanhamento da publicação.   |

As wallets começam com `(2 × teto de operações + 10).00 BRL`, usando `bigint`
para construir a string. Isso cobre o máximo de BETs de warm-up e medição na hot
wallet, com margem de `10.00`. Não há cenário de insuficiência esperada. Uma
resposta `BET_INSUFFICIENT_BALANCE` é classificada como rejeição de negócio,
mas torna esta execução malsucedida porque indica dados de preparação incorretos.

O custo dos replays fica separado das novas BETs. No cenário C, warm-up, corrida
inicial e BET posterior totalizam três débitos; os milhares de replays da janela
não devem acrescentar ledger nem eventos.

## Perfis e parâmetros

| Variável              | Quick | Standard | Valores aceitos               |
| --------------------- | ----: | -------: | ----------------------------- |
| `LOAD_DURATION_MS`    |  8000 |    30000 | 1000 a 300000                 |
| `LOAD_WARMUP_MS`      |  2000 |     5000 | 0 a 30000                     |
| `LOAD_CONCURRENCY`    |     6 |       12 | 2 a 100                       |
| `LOAD_WALLETS`        |    12 |       24 | concorrência a 1000           |
| `LOAD_MAX_OPERATIONS` |   600 |     6000 | 10 a 100000, por fase/cenário |
| `LOAD_SQS_RATE`       |    10 |       25 | 1 a 1000 envios/s             |
| `LOAD_TIMEOUT_MS`     | 10000 |    10000 | 10 a 60000                    |
| `LOAD_DRAIN_MS`       | 60000 |   120000 | 1000 a 300000, por drenagem   |

Todos são inteiros validados. Escolha `LOAD_PROFILE=quick` ou `standard`; Quick é
o padrão. Passe overrides com `docker compose ... run --rm -e NOME=valor load`
ou com variáveis de ambiente no launcher. Não há geração pseudoaleatória:
partições e sequência são determinísticas; UUIDs isolam as execuções.

Os limites de operações reduzem o custo em notebooks. A janela pode terminar
bem antes dos 8 ou 30 segundos. Para estudar uma carga sustentada, aumente o teto
explicitamente; isso aumenta ledger, Outbox e mensagens retidas. A preparação,
o warm-up e as drenagens também consomem tempo e não integram a janela HTTP.

## Definição das métricas

Latência HTTP usa `performance.now()` desde o início do fetch até o corpo inteiro
ser recebido. Amostras de timeout e falhas também são preservadas. Os percentis
usam nearest-rank: ordenar `n` amostras e selecionar o índice
`ceil(p × n) - 1`. Não há interpolação ou inferência por médias. Um conjunto
vazio retorna `null`; conjuntos pequenos têm pouca resolução para p99.

Throughput HTTP é o número de respostas PROCESSED concluídas dentro da janela
dividido pelos segundos dessa janela. Respostas posteriores ao corte entram nas
latências e contagens totais, mas não nessa taxa. No SQS, a mesma conta mede
SendMessage confirmado, não processamento financeiro. As taxas financeiras e de
publicação usam o intervalo observado até o snapshot SQL de encerramento,
registrado em `observationWindowMs`; esse intervalo inclui a finalização do
observador e pode exceder a janela nominal de envio.

A latência assíncrona observada começa antes do SendMessage e termina quando uma
consulta SQL vê a BET PROCESSED já confirmada. O relógio é monotônico no driver.
Há uma pausa de 250 ms entre observações, acrescida do custo de SQL/rede, com
lotes de até 1000 IDs pendentes. É um limite superior com atraso de observação,
sem incluir publicação ou ACK. O schema não fornece duração exata da execução:
`created_at` e `processed_at` da operação compartilham o mesmo timestamp.

O intervalo de publicação usa `published_at - created_at` de cada registro
Outbox, calculado no PostgreSQL com `percentile_disc`, equivalente ao
nearest-rank. `created_at` usa o início da transação SQL; `published_at` é a
marcação depois do aceite confirmado pelo SDK SQS. O intervalo inclui tempo
anterior ao commit, polling, envio e finalização SQL. Não mede exatamente
commit até aceite no broker. O lag instantâneo é a idade do evento PENDING mais
antigo em cada snapshot, acompanhado da quantidade pendente.

Erros técnicos, infraestrutura, timeout, conflito HTTP, validação, pendência e
rejeição de negócio têm categorias próprias. SQLSTATE não é exposto pela API:
`sqlConflicts` fica `null`, com a razão. O relatório registra separadamente
deadlocks globais do banco e sessões amostradas esperando lock, inclusive consultas
de wallet com FOR UPDATE. Uma espera bem-sucedida não é conflito SQL.

## Ambiente das execuções

As execuções finais ocorreram em 30/10/2026, entre 12:42 e 12:45 no fuso
America/Sao_Paulo. Branch `feat/load-testing`, commit
`f4a54d7cdb3d65048873973945d836c831751d78`; aplicação preservada da main
`a791f01852fbb22a4e15d2af0d2323873e0a89e3`.

| Item                                       | Valor detectado                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Host                                       | Windows 10.0.26200, AMD Ryzen 7 9800X3D, 16 CPUs lógicas                                          |
| Memória host / livre no início do Standard | 33396482048 / 8258969600 bytes                                                                    |
| Docker                                     | Desktop 4.93.0, Engine 29.8.1, Linux/amd64                                                        |
| VM / driver                                | WSL2 6.18.54.1; 16 CPUs, 16294768640 bytes de RAM                                                 |
| Bun                                        | 1.4.4                                                                                             |
| Serviços                                   | PostgreSQL 18.3-bookworm, LocalStack 4.14.0, Nginx unprivileged 1.30.6-alpine; digests no Compose |
| Imagem runtime efetiva                     | `sha256:22707e2f249c14bbe6cc1fc15fe796e8359fba58aec5f82d318851f336b4d945`                         |
| Limites dos containers                     | Sem limites individuais explícitos de CPU/RAM; sujeitos à VM e ao host                            |

Três APIs, dois consumers, dois publishers e o worker de referências continuaram
na stack existente. No snapshot Standard, PIDs host das APIs: 43234, 43616 e
43418; consumers: 43319 e 43165; publishers: 43522 e 43691. Os IDs e imagens
completos ficam no JSON do launcher. As referências de imagem no Docker direto
vêm do Compose, enquanto o launcher inspeciona os containers em execução.

## Resultados HTTP

Run Quick: `load-bb43be39-974d-4cbc-b0c8-cccf860f0b7b`, via Docker direto,
15:42:11 a 15:42:44 UTC. Run Standard:
`load-e2d69570-67a7-4dda-a630-b9f6427614f2`, via `LOAD_PROFILE=standard bun run test:load`,
15:42:57 a 15:45:33 UTC. Ambos terminaram PASS. As tabelas arredondam somente
a apresentação; os JSONs locais mantêm as amostras originais.

| Perfil / cenário        | Concorrência | Wallets | Amostras | Janela efetiva (s) |   ops/s | p50 (ms) | p95 (ms) | p99 (ms) | Máxima (ms) |
| ----------------------- | -----------: | ------: | -------: | -----------------: | ------: | -------: | -------: | -------: | ----------: |
| Quick, independentes    |            6 |      12 |      600 |              0.647 |  927.51 |     6.04 |     8.42 |    12.24 |       20.11 |
| Quick, hot reduzida     |            3 |       1 |      600 |              2.018 |  297.26 |     9.63 |    14.12 |    16.98 |       29.65 |
| Quick, hot              |            6 |       1 |      600 |              2.037 |  294.53 |    10.09 |    89.13 |   201.60 |      248.83 |
| Quick, replays          |            6 |       1 |      600 |              0.582 | 1030.53 |     5.61 |     7.16 |     8.61 |       12.95 |
| Standard, independentes |           12 |      24 |     6000 |              5.069 | 1183.65 |     9.59 |    14.83 |    18.14 |       28.91 |
| Standard, hot reduzida  |            6 |       1 |     6000 |             21.546 |  278.48 |    10.40 |    89.20 |   205.64 |      549.87 |
| Standard, hot           |           12 |       1 |     6000 |             21.876 |  274.27 |    10.72 |   193.96 |   673.55 |     2025.89 |
| Standard, replays       |           12 |       1 |     6000 |              5.895 | 1017.79 |    11.44 |    13.96 |    16.06 |       23.64 |

Todas as requisições HTTP medidas concluíram dentro das respectivas janelas.
Cada cenário alcançou as três APIs: 200 respostas por backend no Quick e 2000
no Standard, verificadas por `X-Demo-Upstream`. Erros técnicos, timeouts,
rejeições e conflitos HTTP foram zero. O delta de deadlocks do banco foi zero.
O pico amostrado de espera pelo lock de wallet foi 0 nas wallets independentes,
2/5 nas hot Quick e 5/11 nas hot Standard, para concorrência reduzida/completa.

Na corrida inicial de idempotência houve 6 requisições no Quick e 12 no Standard,
com exatamente uma execução inicial em cada corrida. A janela de replays começou
depois da BET adicional. Não houve novo débito ou fato Outbox pelos replays.

## Outbox e drenagem

| Perfil / cenário        | Eventos da medição | p50 publicação (ms) | p95 (ms) | p99 (ms) | Backlog início / pico / final | Drenagem (ms) |
| ----------------------- | -----------------: | ------------------: | -------: | -------: | ----------------------------- | ------------: |
| Quick, independentes    |               1200 |             1497.59 |  2284.39 |  2321.63 | 0 / 1176 / 0                  |       2258.83 |
| Quick, hot reduzida     |               1200 |              985.78 |  1018.80 |  1022.36 | 0 / 572 / 0                   |        825.09 |
| Quick, hot              |               1200 |              831.09 |   861.31 |   864.85 | 0 / 476 / 0                   |        827.01 |
| Standard, independentes |              12000 |            10471.01 | 17601.73 | 18189.86 | 0 / 10108 / 0                 |      18265.26 |
| Standard, hot reduzida  |              12000 |             1153.23 |  1235.92 |  1245.48 | 0 / 662 / 0                   |       1316.78 |
| Standard, hot           |              12000 |             1536.56 |  2004.29 |  2026.61 | 0 / 966 / 0                   |       1677.61 |
| Quick, SQS              |                162 |              504.38 |   964.04 |  1013.78 | 0 / 20 / 0                    |        550.21 |
| Standard, SQS           |               1502 |              505.18 |   961.44 |  1004.60 | 0 / 50 / 0                    |        360.66 |

O backlog dessa tabela é SQL, limitado ao provider de medição. Os picos são
amostrados e podem subestimar o pico real. Retries adicionais de claim Outbox e
participações extras confirmadas da Inbox foram zero. Attempts da Inbox não conta
rollback ou redelivery que nunca confirmou. Os dois IDs de publisher apareceram
nos claims observados; isso comprova participação, sem atribuir uma taxa individual.

## SQS: submissão, confirmação e publicação

| Métrica                                       |                    Quick |                 Standard |
| --------------------------------------------- | -----------------------: | -----------------------: |
| Janela nominal de envio                       |                      8 s |                     30 s |
| Envios dentro da janela / taxa                |         80 / 10.00 por s |        750 / 25.00 por s |
| Envios totais, incluindo conclusão após corte |                       81 |                      751 |
| BETs confirmadas após drenagem                |                       81 |                      751 |
| Eventos publicados                            |                      162 |                     1502 |
| Confirmação observada p50 / p95 / p99 (ms)    | 152.33 / 267.05 / 282.25 | 164.45 / 298.32 / 314.24 |
| Latência SendMessage p50 / p95 / p99 (ms)     |      2.73 / 4.55 / 10.68 |      2.12 / 5.66 / 10.46 |
| Taxa financeira no intervalo observado        |               9.48 ops/s |              24.59 ops/s |
| Taxa de publicação no intervalo observado     |          18.25 eventos/s |          49.17 eventos/s |

No Standard, o intervalo observado foi 30.545 s, com 751 confirmações financeiras
e 1502 publicações no snapshot final. A conta usa esse intervalo inteiro; os
25 envios/s usam somente a janela nominal. Não se assume que SendMessage,
commit SQL, ACK da Inbox e publicação sejam o mesmo marco.

A fila de comandos Standard começou e terminou com zero mensagens visíveis,
invisíveis ou atrasadas; o pico observado foi de duas mensagens invisíveis.
A DLQ permaneceu em zero. A drenagem exige duas amostras consecutivas de comandos
zerados e nenhum crescimento da DLQ, além das verificações SQL. Atributos SQS
são aproximados, portanto essa evidência depende de uma demo sem produtores
concorrentes. Não fornece um timestamp exato de ACK por mensagem.

A fila de eventos começou com 130530 mensagens e terminou com 132032 no cenário
SQS Standard. Esse estoque inclui execuções anteriores e os cenários HTTP.
O benchmark não consome ou apaga eventos: uma fila de eventos com mensagens
retidas não é Outbox PENDING. Os dois consumers mantiveram conexões observáveis
no PostgreSQL; a ferramenta não atribui cada comando a um consumer específico.

## Consistência financeira

A reconciliação executa uma consulta agregada com snapshot SQL único, sem trazer
o ledger inteiro para o driver. Verifica abertura positiva única, soma exata dos
créditos/débitos, saldo não negativo e continuidade dos débitos unitários desde a
abertura até o saldo final. Contagens por transação exigem exatamente um lançamento,
um resultado idempotente compatível e dois fatos publicados por BET:
WagerTransactionProcessed e WalletBalanceChanged. OPENING não emite fatos Wagering.

Versão e quantidade de entradas precisam ser `1 + débitos`. As verificações
abrangem warm-up e preparação, embora suas latências não entrem na medição.
Em todas as wallets dos dois perfis, saldo reconstruído e persistido coincidiram,
com zero registros inválidos.

| Wallet única           | Inicial (BRL) | Débitos confirmados, com warm-up/preparação | Final (BRL) | Versão / entradas |
| ---------------------- | ------------: | ------------------------------------------: | ----------: | ----------------: |
| Quick, hot reduzida    |       1210.00 |                                        1192 |       18.00 |              1193 |
| Quick, hot             |       1210.00 |                                        1193 |       17.00 |              1194 |
| Quick, idempotência    |       1210.00 |                                           3 |     1207.00 |                 4 |
| Standard, hot reduzida |      12010.00 |                                        7456 |     4554.00 |              7457 |
| Standard, hot          |      12010.00 |                                        7406 |     4604.00 |              7407 |
| Standard, idempotência |      12010.00 |                                           3 |    12007.00 |                 4 |

O cenário independente Standard confirmou 11841 débitos incluindo warm-up; o SQS, 877. Na janela medida foram 6000 e 751, respectivamente. Cada efeito confirmado
tem os fatos esperados na Outbox e todos chegaram a PUBLISHED. Isso verifica
ausência de perda até o aceite SQS confirmado seguido da marcação SQL. Não prova
persistência downstream ou retenção infinita. A ferramenta não corrige divergências:
uma violação financeira produz erro CRITICAL, relatório de reprodução e saída não zero.

## Interpretação

No Standard, wallets independentes confirmaram 1183.65 ops/s, contra 274.27 ops/s
na hot wallet. O maior p95/p99 HTTP foi da hot wallet com 12 concorrentes.
Ao dobrar sua concorrência de 6 para 12, o throughput caiu de 278.48 para
274.27 ops/s, enquanto p99 passou de 205.64 para 673.55 ms. O pico de espera
pelo lock passou de 5 para 11 sessões. Nesse experimento, aumentar concorrência
acrescentou espera sem ganho de throughput.

Essas observações são compatíveis com a serialização por wallet. Não isolam toda
a latência entre lock, pool, scheduler e I/O. O cenário independente admite mais
commits paralelos, mas sua rajada produziu Outbox mais rápido do que a publicação
conseguiu acompanhar: o pico foi de 10108 eventos e o p99 de publicação chegou a
18.19 s. A Outbox drenou completamente depois da parada dos produtores.

O fluxo SQS a 25 envios/s manteve backlog SQL pequeno e drenou. Esse cenário
controlado não procurou saturar os consumers. A medição mostra contenção na hot
wallet e atraso no caminho de publicação durante a rajada independente; não
separou os custos internos de PostgreSQL, LocalStack, SDK e publisher. Não há
dados suficientes para atribuir um gargalo exclusivo à API, ao banco ou ao broker.

## Limitações e próximos experimentos

As janelas HTTP atingiram o teto de operações antes da duração configurada.
O Quick tem janelas inferiores a um segundo em dois cenários, úteis para uma
demonstração curta, com pouca evidência sobre carga sustentada. Mesmo no Standard,
6000 amostras não substituem repetições, intervalos de confiança ou alternância
da ordem dos cenários. O banco e a fila mantiveram o histórico das execuções.

Driver e serviços compartilham a máquina. SQL de observação, consultas sobre
JSONB, Docker Desktop, processos do host e logs interferem no resultado.
Não foram medidos CPU/I/O continuamente, tempos individuais de lock, saturação
dos pools ou consumo downstream. Os números não devem ser extrapolados para
AWS nem reproduzidos numericamente em outro hardware.

Próximos experimentos podem elevar o teto para manter janelas de duração fixa,
repetir os pares de concorrência em ordem alternada e coletar CPU/I/O e wait
events com a mesma carga. Qualquer proposta de alterar locks, agrupamento de
publicação ou tamanho dos pools exige avaliação separada dos efeitos sobre
concorrência e consistência. Nenhuma otimização financeira foi feita aqui.

## Validação da entrega

Os testes da ferramenta cobrem limites, classificação, percentis e throughput,
backpressure, timeout durante leitura do corpo, redirects, interrupção e relatório
incompleto, inclusive sinal durante cleanup/persistência e antes da criação do
container. PostgreSQL real cobre o observador read-only e a recusa de cadeias
desconectadas, fatos não publicados e saldo divergente em fixtures isoladas.

Quick via Docker e Standard via launcher passaram no commit registrado. O smoke
original passou após as cargas na mesma stack, com seus dez eventos recebidos.
O benchmark não foi acrescentado ao CI obrigatório. A suíte da ferramenta integra
a regressão; não há workflow adicional de carga nem nova stack de observabilidade.

SIGINT e SIGTERM reais foram enviados ao container do driver depois de observar
BETs persistidas. Ambos encerraram com código 1 e relatório INCOMPLETE, sem
anunciar PASS. Runs: `load-28d0aef3-6dbd-4380-833a-db6891c1e371` e
`load-682d6784-66eb-4476-96b8-c0f647831f52`, respectivamente. As interrupções
não fazem reconciliação automática nem removem os dados já confirmados.

| Verificação final                                            | Resultado                                          |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `bun test test/load-tool.test.ts test/load-observer.test.ts` | 20 aprovados, zero falhas                          |
| `bun run test`                                               | 507 aprovados, zero falhas, 40 arquivos; 463.40 s  |
| `bun run format:check`                                       | Aprovado                                           |
| `bun run typecheck`                                          | Aprovado                                           |
| `bun run lint`                                               | Aprovado, incluindo fronteiras arquiteturais       |
| `bun run build`                                              | Aprovado                                           |
| `docker compose -f compose.demo.yaml config --quiet`         | Aprovado                                           |
| Revisão independente do código                               | Aprovada após correção dos cinco achados no driver |
| Identidade dos containers da demo                            | Os mesmos 11 IDs antes e depois das execuções      |

A conferência de links, âncoras, frontmatter e comandos faz parte da suíte.
Graphify foi atualizado e localiza o driver e o observador. O diff não contém
alterações em `src/` nem no enunciado. A validação é local; não houve push,
execução remota do CI ou merge na main nesta entrega.
