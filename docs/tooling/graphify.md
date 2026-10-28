# Graphify: navegação do projeto

## Finalidade e autoridade

Graphify é o índice derivado para localizar símbolos e relações **antes de explorar o repositório**. Consulte um subgrafo por pergunta e leia os trechos encontrados, evitando leitura integral da árvore ou do relatório. O índice não substitui [requisitos](../requirements.md), [domínio](../domain/), [arquitetura](../../ARCHITECTURE.md), instruções locais ou código atual.

Integração aprovada pelo pedido de instalação: CLI local `graphifyy==0.9.97`, Python 3.12 isolado por uv e [skill do projeto](../../.agents/skills/graphify/SKILL.md) em formato nativo do Codex. O runtime/package manager/test runner da aplicação continua Bun. Nenhuma dependência Python é adicionada ao aplicativo.

Fontes oficiais: [repositório Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify), [instalação](https://docs.graphify.com/open-source/installation) e [referência CLI](https://docs.graphify.com/open-source/configuration/cli). O pacote oficial tem **dois y** (`graphifyy`); o executável é `graphify`.

## Instalação reproduzível

Na raiz do projeto, com Python disponível, use PowerShell:

```powershell
python -m pip install --user uv
python -m uv tool install --python 3.12 graphifyy==0.9.97
python -m uv tool update-shell
```

Abra outro terminal depois da atualização do PATH. Se precisar continuar no PowerShell atual, acrescente o diretório de executáveis informado pelo uv; nesta instalação foi:

```powershell
$env:PATH = "$env:USERPROFILE/.local/bin;$env:PATH"
graphify --version
```

uv instala o Python compatível quando necessário e mantém o CLI em ambiente isolado. A skill local é mantida neste repositório; não é necessário executar o gerador de integração do Graphify. Reexecutar `graphify install --project --platform codex` pode substituir essa skill e acrescentar instruções/hooks que precisam de revisão. Não altere configurações globais do Codex ou habilite multi-agent para este fluxo.

Atualizações de versão são uma tarefa explícita: revise release/CLI, atualize a versão documentada, reinstale com a versão escolhida e valide construção, consultas e descoberta da skill. Para remover somente o CLI: `python -m uv tool uninstall graphifyy`; isso não remove a documentação/skill local.

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
