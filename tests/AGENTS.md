# Testes

Política comum de testes. Aplica-se a esta árvore; [test/AGENTS.md](../test/AGENTS.md) a referencia para os testes existentes. Hoje o código executável fica em test/, incluído pelo tsconfig; esta pasta não representa migração. Antes de adicionar testes aqui, decida e ajuste a inclusão tipada na tarefa correspondente, sem duplicar suítes.

- Proteja comportamentos observáveis com testes determinísticos, isolamento e teardown mesmo após falha. Não dependa de sleeps arbitrários para criar races.
- Use PostgreSQL e LocalStack/MiniStack reais em containers quando a garantia depender deles; mocks unitários não substituem integração.
- Concorrência distribuída exige processos independentes, não somente promises no mesmo processo; use pelo menos três quando pertinente ao requisito.
- Demonstre atomicidade, ausência de efeitos parciais, saldo reconstruído pelo ledger e recuperação após interrupção/reinício nos fluxos afetados.
- Use [distributed-validation](../.agents/skills/distributed-validation/SKILL.md) para cenários distribuídos. Testes simples não precisam carregar essa skill nem executar toda a suíte futura.

Cenários obrigatórios e fontes originais: [requirements.md](../docs/requirements.md), §§8 e 13 do enunciado. Comandos reais e seleção proporcional ficam no [AGENTS raiz](../AGENTS.md). Não declarar teste distribuído aprovado quando só executou o bootstrap.
