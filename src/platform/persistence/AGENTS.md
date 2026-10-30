# Persistence

Escopo: mecanismos técnicos de persistência. Consulte a unidade de trabalho e pendências de [ARCHITECTURE.md](../../../ARCHITECTURE.md); regras só dos contratos afetados em [Financial](../../../docs/domain/financial.md), [Wagering](../../../docs/domain/wagering.md) ou [Messaging](../../../docs/domain/messaging.md).

- Repositórios do contexto recebido devem usar a mesma transação; mantenha tipos ORM fora dos contratos internos.
- Preserve constraints/índices, unicidade, não-negatividade, ledger imutável e segurança concorrente no PostgreSQL.
- Migrations são versionadas/reversíveis; não use reversão para editar/apagar lançamentos financeiros confirmados. Se a reversibilidade conflitar com dados existentes, explicite a incompatibilidade e proponha alternativa.
- Platform não importa módulos; mapeamentos que dependem do domínio pertencem aos adapters do módulo, compostos no bootstrap.
- Use [persistence-change](../../../.agents/skills/persistence-change/SKILL.md); MikroORM/PostgreSQL, schema inicial e UnitOfWork técnico estão implementados. Confira [schema e decisões](../../../docs/persistence.md); o SQL versionado é a fonte de constraints, FKs compostas e triggers. Não gere um diff automático que remova essas garantias. Mappers/adapters financeiros ficam nos módulos; bootstrap os compõe na mesma sessão. Escritas não abrem transação própria; save de wallet exige a instância adquirida sob lock nessa execução.

Exija evidências reais no PostgreSQL quando a garantia depender do banco; mocks não demonstram constraints, locks ou atomicidade.

Exceção técnica explícita: OutboxStore abre transação curta própria para claim com SKIP LOCKED e confirma antes de SendMessage. Não integra nem prolonga a TransactionSession financeira. Finalização/retry são UPDATEs atômicos com token/PENDING/lease válido. [Contrato](../../../docs/persistence.md#claims-e-fencing).

Task 11: PendingWagerStore do adapter Wagering também confirma aquisição curta
com SKIP LOCKED antes de esperar wallet. A resolução financeira continua na
TransactionSession recebida, com lock da pendência após idempotência/identidade/wallet
e finalização condicional no mesmo commit. Retry técnico isolado só após retorno
da UnitOfWork; nunca dividir saldo/ledger/idempotência/Outbox/finalização.
[Contrato](../../../docs/persistence.md#claims-e-fencing).
