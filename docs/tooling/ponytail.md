# Ponytail no Codex

Ponytail complementa o fluxo do projeto com simplicidade, reutilização e revisão. Instalado como plugin nativo do Codex no perfil do usuário, com seis skills; não adiciona dependências à aplicação Bun nem copia outro AGENTS.md sobre as instruções locais.

Fonte: [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), [instalação oficial para Codex](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md#codex). Versão verificada: **5.3.2**; revisão inspecionada: `09c434ab73ca43761c5d8b0c5d341926c2fba710`.

## Instalação e ativação

```powershell
codex plugin marketplace add DietrichGebert/ponytail --ref 09c434ab73ca43761c5d8b0c5d341926c2fba710
codex plugin add ponytail@ponytail
codex plugin list --marketplace ponytail --json
```

A instalação é local a cada máquina. O último comando deve informar installed/enabled e a versão do plugin. Reinstalações e upgrades devem conferir a versão efetivamente resolvida; a dependência não pertence ao bun.lock.

Os hooks usam Node.js no PATH (verificado nesta instalação: v24.13.0). Abra `/hooks` no Codex para revisar e confiar nos hooks do plugin, conforme INSTALL.md; depois inicie uma nova conversa. No aplicativo desktop, reinicie o Codex para carregar a instalação. A instalação e descoberta das skills não significam que os hooks já foram autorizados ou executados.

O padrão upstream é full. A interface de Claude Code chamada band não é um recurso instalado no aplicativo por esta integração.

## Skills disponíveis

No Codex CLI/IDE, use os nomes nativos do plugin; no desktop, selecione a skill no catálogo:

| Invocação                   | Uso                                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| `$ponytail:ponytail`        | Aplicar o procedimento de menor mudança completa; aceita lite/full/ultra/off |
| `$ponytail:ponytail-review` | Revisar um diff/escopo, incluindo correção, segurança e testes relevantes    |
| `$ponytail:ponytail-audit`  | Auditar escopo amplo quando solicitado                                       |
| `$ponytail:ponytail-debt`   | Localizar atalhos documentados e organizar dívida                            |
| `$ponytail:ponytail-gain`   | Consultar resultados de benchmark upstream; não são medições deste projeto   |
| `$ponytail:ponytail-help`   | Referência de comandos                                                       |

## Integração com o contexto

Siga o [AGENTS raiz](../../AGENTS.md): consulte Graphify antes de buscas exploratórias, depois leia os trechos relevantes. Na revisão de callers sugerida pelo Ponytail, localize-os pelo grafo e complemente com busca restrita quando necessário.

Simplicidade deve preservar os contratos de [domínio](../domain/) e as fronteiras de [arquitetura](../../ARCHITECTURE.md). Não use a preferência por stdlib/menos código para remover precisão monetária, idempotência persistente, ledger, atomicidade ou validações exigidas. A skill principal da tarefa continua orientando as responsabilidades específicas; Ponytail é complementar.

Validação segue o impacto concreto: os testes obrigatórios do desafio continuam exigidos quando aplicáveis; mudanças triviais não ganham testes artificiais. Auditoria ampla não é executada por padrão. Entregas ao Git continuam em main, com commits separados por contexto e até 500 linhas alteradas; a exceção já autorizada é a importação integral do enunciado.

Para remover o plugin: `codex plugin remove ponytail`. Isso não remove este guia nem altera os contratos do projeto.
