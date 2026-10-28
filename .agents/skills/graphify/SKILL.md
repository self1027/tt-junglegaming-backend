---
name: graphify
description: Consultar, gerar ou atualizar o grafo Graphify do projeto para localizar símbolos, dependências e relações antes de explorar arquivos. Use para navegação do código ou manutenção do índice; a skill de domínio continua responsável pela alteração.
---

# Graphify

## Entradas

Pergunta ou símbolo a localizar, escopo da tarefa e estado do grafo local. Setup, comandos, cobertura e recuperação ficam em [graphify.md](../../../docs/tooling/graphify.md).

## Procedimento

1. Para pergunta sobre código, consulte primeiro `bun run graph:query "pergunta com os nomes dos símbolos"`. Se o grafo estiver ausente, execute `bun run graph:build`; se arquivos indexados mudaram, `bun run graph:update`.
2. Use `bun run graph:explain "símbolo"` para vizinhança e `bun run graph:path "origem" "destino"` para relações. Desambigue pelos candidatos e caminhos retornados; não leia o JSON ou relatório inteiro para uma pergunta pontual.
3. Leia somente os arquivos/trechos apontados e suas instruções locais; consulte contratos relevantes pelo [AGENTS raiz](../../../AGENTS.md). EXTRACTED registra extração; INFERRED é inferência a confirmar no código, não decisão arquitetural.
4. Se a consulta não localizar o alvo após uma reformulação com identificadores conhecidos, registre a lacuna e use `rg` restrito ao escopo provável. Grafo incompleto não proíbe investigar nem substitui fontes primárias.
5. Depois de alterar código/configuração indexada, atualize o grafo e repita a consulta afetada. Se a atualização falhar, informe o estado desatualizado e o erro; não force sobrescrita sem investigar.

## Verificações

O padrão local é extração estrutural sem LLM/API, com exclusões em [.graphifyignore](../../../.graphifyignore): AST de código e títulos/links de Markdown. Isso não extrai os contratos completos nem representa implementação em diretórios vazios planejados. Leia fontes obrigatórias diretamente quando necessário; a leitura integral do enunciado antes de nova documentação derivada continua válida.

Não ative backend, Cloud, hooks, watcher ou subagentes para consultas comuns. Validação de arquitetura continua em `bun run lint`; o grafo auxilia navegação e não prova invariantes.

## Evidências de conclusão

Informe consulta executada, símbolos/caminhos encontrados, arquivos efetivamente conferidos e atualização quando aplicável. Diferencie ausência de resultado de ausência real no código e registre limitações de cobertura.
