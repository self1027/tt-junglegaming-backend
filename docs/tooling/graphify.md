# Graphify: navegação do projeto

## Finalidade e autoridade

Graphify é o índice derivado para localizar símbolos e relações **antes de explorar o repositório**. Consulte um subgrafo por pergunta e leia os trechos encontrados, evitando leitura integral da árvore ou do relatório. O índice não substitui [requisitos](../requirements.md), [domínio](../domain/), [arquitetura](../../ARCHITECTURE.md), instruções locais ou código atual.

Integração aprovada pelo pedido de instalação: CLI local `graphifyy==0.9.97`, Python 3.12 isolado por uv e [skill do projeto](../../.agents/skills/graphify/SKILL.md) em formato nativo do Codex. O runtime/package manager/test runner da aplicação continua Bun. Nenhuma dependência Python é adicionada ao aplicativo.

Fontes oficiais: [repositório Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify), [instalação](https://docs.graphify.com/open-source/installation) e [referência CLI](https://docs.graphify.com/open-source/configuration/cli). O pacote oficial tem **dois y** (`graphifyy`); o executável é `graphify`.

## Instalação reproduzível

Instale uv pelo [distribuidor oficial](https://docs.astral.sh/uv/getting-started/installation/), sem depender do alias `python` da Microsoft Store. Em PowerShell, a instalação oficial fixada é:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/0.13.6/install.ps1 | iex"
$env:PATH = "$env:USERPROFILE/.local/bin;$env:USERPROFILE/.bun/bin;$env:PATH"
uv tool install --python 3.12 graphifyy==0.9.97
uv tool update-shell
```

Também é possível baixar o binário Windows da release oficial e conferir seu SHA-256 antes de copiar uv/uvx/uvw para `.local/bin`, como feito na recuperação abaixo. Não é necessário instalar Python global: uv resolve o Python 3.12 isolado. Abra outro terminal e **reinicie o Codex desktop** depois de alterar o PATH; processos já abertos conservam o ambiente anterior. Para continuar no PowerShell atual:

```powershell
$env:PATH = "$env:USERPROFILE/.local/bin;$env:USERPROFILE/.bun/bin;$env:PATH"
$env:PYTHONUTF8 = '1'
$env:GRAPHIFY_NO_AUTO_REFRESH = '1'
graphify --version
```

uv instala o Python compatível quando necessário e mantém o CLI em ambiente isolado. A skill local é mantida neste repositório; não é necessário executar o gerador de integração do Graphify nem acrescentar AGENTS/hooks. O CLI 0.9.97 pode atualizar automaticamente a skill global `~/.codex/skills/graphify` durante comandos comuns; `GRAPHIFY_NO_AUTO_REFRESH=1` evita essa alteração quando se deseja somente consultar/atualizar o índice. Não habilite multi-agent ou backends para esse fluxo.

Atualizações de versão são uma tarefa explícita: revise release/CLI, atualize a versão documentada, reinstale com a versão escolhida e valide construção, consultas e descoberta da skill. Para remover somente o CLI: `uv tool uninstall graphifyy`; isso não remove a documentação/skill local.

## Recuperação verificada — 2026-10-28

Na Task 06, o executável Graphify e uv não estavam disponíveis no PATH nem nos locais de instalação verificados; o índice não existia. A presença da skill não significava instalação do CLI. A causa histórica da ausência não foi determinada.

Recuperação autorizada posteriormente pelo usuário:

- uv **0.13.6** instalado por binário oficial Windows x86_64, SHA-256 conferido contra o digest da release: `a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f`.
- `uv tool install --python 3.12 graphifyy==0.9.97` concluiu; `uv tool list` lista graphify e graphify-mcp. Não foi configurado servidor MCP ou backend externo.
- `uv tool update-shell` adicionou `.local/bin` ao PATH do usuário; `.bun/bin` também foi incluído para executar os scripts existentes. Reabrir o Codex aplica esse ambiente às novas sessões.
- A primeira consulta atualizou automaticamente a skill global de 0.9.94 para 0.9.97, preservando `SKILL.md.bak`. A skill `.agents/skills/graphify/SKILL.md` do projeto foi preservada. Comandos posteriores usaram `GRAPHIFY_NO_AUTO_REFRESH=1`.
- `bun run graph:build` passou: **679 nós, 1511 relações e 40 comunidades**, extração estrutural local de 93 arquivos; HTML, JSON e relatório gerados em `graphify-out/`, ignorado pelo Git. Contagens podem mudar após atualização da documentação.
- `graph:query "ProcessWagerUseCase idempotencyScope"`, `graph:explain "ProcessWagerUseCase"` e `graph:path "ProcessWagerUseCase" "WagerTransaction"` passaram. Caminho encontrado em dois saltos pela relação de import do arquivo do caso de uso.
- Cinco arquivos não produziram símbolos individuais, incluindo barrels públicos, configuração CLI e duas fixtures/testes; seus imports/conteúdo continuam exigindo confirmação direta. Ausência no grafo não prova ausência de implementação.

Nenhuma dependência da aplicação, contrato financeiro ou configuração strict foi alterada para instalar o tooling. Não foram ativados Cloud, watcher, Git hooks ou extração semântica por LLM.

## Comandos do projeto

Os scripts estão em [package.json](../../package.json). Execute-os da raiz, com Bun e graphify no PATH.

| Comando                                      | Uso                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `bun run graph:build`                        | Gera o índice e artefatos locais a partir de zero por graphify update .      |
| `bun run graph:update`                       | Atualiza código alterado por graphify update ., sem LLM                      |
| `bun run graph:query "createApi ApiModule"`  | Obtém contexto restrito aos símbolos/pergunta                                |
| `bun run graph:explain "createApi"`          | Mostra símbolo, origem e vizinhança                                          |
| `bun run graph:path "createApi" "ApiModule"` | Busca caminho entre símbolos; argumentos ambíguos exigem escolher candidatos |

Construção e atualização usam o mesmo comando nativo: `graphify update .` também inicializa um índice ausente. Os nomes dos símbolos ajudam o mecanismo de correspondência: se uma pergunta em português não produzir resultado útil, reformule com identificadores reais. Não interprete falta de correspondência como prova de inexistência.

## Artefatos, cobertura e atualização

O CLI gera `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, visualização `graphify-out/graph.html` e sidecars de cache/metadados. São artefatos locais ignorados pelo Git e Prettier; cada clone gera seu índice. Não copie esses arquivos integralmente para o contexto. Abra o HTML para exploração visual; reserve o relatório para análise ampla de arquitetura.

O padrão aprovado é **extração estrutural local**, sem chamadas LLM ou chave API, com [exclusões nativas](../../.graphifyignore) e .gitignore: AST de código/configurações suportados e estrutura de títulos/links de Markdown. Isso localiza documentos, mas não extrai integralmente seus contratos; pastas vazias não representam módulos implementados. Fixtures e referências dinâmicas podem gerar nós sem caminho resolvido: confirme a origem real. Expansão semântica para documentos ou serviços externos requer desenho e escopo próprios, sem transformar relações inferidas em requisitos.

Antes de usar: confira se o índice existe e se houve alterações de arquivos indexados desde a última construção/atualização. Atualize ao iniciar uma tarefa quando isso for incerto e após mudanças indexadas, inclusive títulos/links de Markdown. Alteração das exclusões também exige atualização. O índice não é watcher nem atualização automática em segundo plano.

Se geração/atualização falhar, registre o erro e não anuncie grafo atual. Use busca restrita como fallback para prosseguir onde houver evidência suficiente; não use `--force` para esconder falha ou redução inesperada. Revalide linhas apontadas, pois podem estar antigas.

## Fluxo do agente e verificação

1. Consulte o grafo para localizar o escopo antes da primeira busca/leitura exploratória de código.
2. Leia AGENTS local e fontes/contratos relevantes; confirme relações nos trechos encontrados.
3. Faça a mudança e execute validações proporcionais da tarefa. Graphify não substitui dependency-cruiser, lint, testes ou revisão.
4. Atualize o índice se arquivos indexados mudaram e confirme a consulta afetada.

Para validar uma instalação: confira `graphify --version`, execute construção e consultas da tabela, abra a visualização se necessário e confirme a skill graphify no catálogo nativo do Codex. query/path/explain usam código de saída 0 para resposta, 3 para nome ambíguo e 4 para ausência de correspondência; trate candidatos/ausência antes de concluir falha do índice.
