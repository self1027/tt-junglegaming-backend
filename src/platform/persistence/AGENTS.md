# Persistence

Escopo: mecanismos técnicos de persistência. Consulte a unidade de trabalho e pendências de [ARCHITECTURE.md](../../../ARCHITECTURE.md); regras só dos contratos afetados em [Financial](../../../docs/domain/financial.md), [Wagering](../../../docs/domain/wagering.md) ou [Messaging](../../../docs/domain/messaging.md).

- Repositórios do contexto recebido devem usar a mesma transação; mantenha tipos ORM fora dos contratos internos.
- Preserve constraints/índices, unicidade, não-negatividade, ledger imutável e segurança concorrente no PostgreSQL.
- Migrations são versionadas/reversíveis; não use reversão para editar/apagar lançamentos financeiros confirmados. Se a reversibilidade conflitar com dados existentes, explicite a incompatibilidade e proponha alternativa.
- Platform não importa módulos; mapeamentos que dependem do domínio pertencem aos adapters do módulo, compostos no bootstrap.
- Use [persistence-change](../../../.agents/skills/persistence-change/SKILL.md); ainda não há ORM escolhido nem schema implementado.

Exija evidências reais no PostgreSQL quando a garantia depender do banco; mocks não demonstram constraints, locks ou atomicidade.
