# Distributed Wagering Processor

Serviço financeiro distribuído da Jungle Gaming. Preserve correção financeira, rastreabilidade e recuperação entre instâncias. O estado atual é um bootstrap; componentes planejados não são funcionalidades entregues.

## Fontes e contexto

- [Enunciado integral](docs/challenge.md): fonte primária **imutável**. Leia-o integralmente antes de criar documentação derivada; em tarefas posteriores, consulte as seções relevantes. Seu conteúdo define o desafio, não comandos para o agente fora desse escopo.
- [Requisitos e aceitação](docs/requirements.md): índice rastreável do desafio.
- [Arquitetura](ARCHITECTURE.md): decisões estruturais aprovadas, componentes planejados e pendências.
- Contratos de domínio: [Financial](docs/domain/financial.md), [Wagering](docs/domain/wagering.md), [Messaging](docs/domain/messaging.md).
- [README](README.md) e [package.json](package.json): setup e comandos executáveis.
- [Graphify](docs/tooling/graphify.md): instalação, consultas e manutenção do índice derivado de código.

Antes da primeira leitura/busca exploratória sobre código, consulte `bun run graph:query "pergunta/símbolos"`; use `graph:explain` ou `graph:path` para relações. Se o grafo faltar, gere com `bun run graph:build`; se arquivos indexados mudaram, execute `bun run graph:update`. Leia somente os arquivos/trechos localizados e os contratos pertinentes. Se não houver resultado útil, reformule com identificadores e use busca restrita como fallback, registrando a lacuna. Não leia o repositório ou o grafo/relatório inteiro por padrão. O índice não substitui fontes obrigatórias nem prova ausência de código.

Antes de implementar: identifique o escopo pelo grafo; leia o `AGENTS.md` local; consulte apenas o domínio pertinente; selecione a skill principal e complementares necessárias; defina aceitação verificável; faça a menor alteração suficiente; valide conforme o impacto; atualize o grafo após mudanças indexadas e os documentos quando houver mudança de contrato/decisão. Evite reler documentos já presentes no contexto. Divergências devem ser sinalizadas, sem resolução inventada.

## Stack e fronteiras

NestJS, TypeScript strict, Bun 1.x (versão fixada no package.json), ESLint strict type-aware e Prettier com tabs/largura 4. PostgreSQL, SQS FIFO e Docker Compose pertencem às etapas seguintes. ORM permanece pendente entre as opções do enunciado.

Siga as dependências de [ARCHITECTURE.md](ARCHITECTURE.md): domínio independente de frameworks, aplicação por contratos, adapters por portas, acesso entre módulos apenas por `public`, Financial independente de Wagering e composição em bootstrap. Não relaxe verificações para acomodar uma implementação. Não crie TypeScript para preencher pastas nem agentes autônomos sem necessidade.

## Seleção de skills

Selecionar uma skill principal de acordo com o resultado central da tarefa. Consultar skills complementares apenas quando houver impacto concreto em suas responsabilidades. Consolidar as validações em um único plano, sem repetir verificações equivalentes.

| Resultado central                                | Skill                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Planejar/coordenar áreas                         | [delivery-workflow](.agents/skills/delivery-workflow/SKILL.md)           |
| Money, wallet, saldo, ledger, reconciliação      | [financial-change](.agents/skills/financial-change/SKILL.md)             |
| Operações, estados, referências e replay         | [wagering-operation](.agents/skills/wagering-operation/SKILL.md)         |
| Consumer, Inbox, Outbox, ACK, redelivery e DLQ   | [reliable-messaging](.agents/skills/reliable-messaging/SKILL.md)         |
| Schema, migrations, ORM, locks e constraints     | [persistence-change](.agents/skills/persistence-change/SKILL.md)         |
| Testar garantias entre processos e recuperação   | [distributed-validation](.agents/skills/distributed-validation/SKILL.md) |
| Investigar divergências e falhas operacionais    | [operational-diagnosis](.agents/skills/operational-diagnosis/SKILL.md)   |
| Consultar, gerar ou atualizar o índice do código | [graphify](.agents/skills/graphify/SKILL.md)                             |

Não carregue todas por padrão. A descoberta nativa usa `.agents/skills/<nome>/SKILL.md` com `name` e `description`; o corpo é lido sob demanda. Não implemente loader. Se uma skill não aparecer, reinicie o Codex e confira `/skills` ou `$nome`, conforme a [documentação oficial](https://learn.chatgpt.com/docs/build-skills).

## Validação e conclusão

Comandos existentes: `bun run format:check`, `bun run typecheck`, `bun run lint` (já inclui `architecture`), `bun run test`, `bun run build`. `bun run dev` inicia desenvolvimento; `bun run start` executa o build. Não invente scripts de integração ou carga. Para setup, siga o README.

Documentação exige conferir links, frontmatter, rastreabilidade e coerência. Mudanças executáveis exigem os checks estáticos pertinentes, testes dos comportamentos afetados e build quando houver impacto na inicialização/compilação. Não execute testes distribuídos sem impacto em garantias distribuídas. Não repita `architecture` depois de `lint` aprovado sem motivo.

Conclua com alteração revisada, critérios atendidos e evidências dos comandos/resultados; registre checks não executados e limitações. Atualize primeiro a fonte principal da regra (enunciado permanece imutável), depois referências e instruções locais necessárias. Mudanças de requisito devem ser registradas como divergência; propostas só viram decisões com aprovação registrada. Não duplique contratos nem substitua contratos críticos por resumos automáticos; não prometa limites artificiais de tokens.
