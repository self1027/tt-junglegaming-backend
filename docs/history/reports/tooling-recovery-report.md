# Recuperação de tooling

> HISTORICAL: registros preservados dos guias Graphify e Ponytail. Resultados pertencem a 2026-10-28.

## Graphify

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

## Ponytail

## Recuperação verificada — 2026-10-28

Antes da recuperação, as seis skills locais estavam disponíveis, mas `codex plugin list --json` não listava Ponytail. A afirmação de instalação neste guia não correspondia ao estado daquela sessão.

Os comandos acima foram executados novamente pelo gerenciador nativo. `codex plugin list --marketplace ponytail --json` confirmou `ponytail@ponytail`, versão **5.3.2**, `installed: true` e `enabled: true`. Manifesto/skills instalados em `~/.codex/plugins/cache/ponytail/ponytail/5.3.2`. A revisão pinada do marketplace corresponde à inspecionada acima; confira sempre a versão resolvida do plugin após upgrades.

O manifesto instalado declara três eventos: SessionStart, UserPromptSubmit e SubagentStart. Os três scripts foram inspecionados e executados com diretório de estado temporário, em formato Codex: todos retornaram contexto JSON do evento correspondente e estado `full`. Esse smoke test confirma compatibilidade dos scripts com Node, sem alegar que o aplicativo em execução já os carregou. Skills locais preexistentes e AGENTS do projeto foram preservados; nenhum registro de confiança dos hooks foi alterado automaticamente. Para ativação nas novas sessões, reinicie o aplicativo e revise/confie nos hooks em `/hooks` conforme o fluxo oficial.

O padrão upstream é full. A interface de Claude Code chamada band não é um recurso instalado no aplicativo por esta integração.

## Instrução Git anterior

Trecho removido da referência atual por não corresponder às instruções Git desta auditoria:

> Entregas ao Git continuam em main, com commits separados por contexto e até 500 linhas alteradas; a exceção já autorizada é a importação integral do enunciado.
