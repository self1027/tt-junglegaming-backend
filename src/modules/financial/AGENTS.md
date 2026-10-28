# Financial

Escopo: public, domain, application e adapters de Financial. Fonte das regras: [financial.md](../../../docs/domain/financial.md); dependências/fronteira transacional: [ARCHITECTURE.md](../../../ARCHITECTURE.md).

- Preserve precisão monetária, Money imutável, Wallet encapsulada e saldo não negativo.
- Preserve ledger imutável e correspondência exata entre movimentação e lançamento; não mude versão sem mudança de saldo.
- Não importe Wagering. Exponha contratos por public e participe da unidade transacional recebida, sem abrir transação independente.
- Abertura tem caso de uso/fronteira próprios; não comprometa a independência do módulo ao registrar OPENING.
- Use [financial-change](../../../.agents/skills/financial-change/SKILL.md). Consulte persistência ou validação distribuída somente se a mudança afetar essas garantias.

Comprove invariantes afetadas e reconciliação quando pertinente. Não escolha representação monetária ou política financeira pendente como se já estivesse aprovada.
