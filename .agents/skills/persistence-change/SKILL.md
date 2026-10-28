---
name: persistence-change
description: Criar ou alterar schema, migrations, repositórios, mapeamento ORM, locks, constraints ou índices. Use quando o resultado central modificar integridade, armazenamento ou coordenação no PostgreSQL.
---

# Persistence change

## Entradas

Schema/migration/porta afetada, invariantes protegidas, versão de origem/destino e impacto sobre dados existentes e concorrência. Confira se o ORM já foi aprovado.

## Procedimento

1. Leia [AGENTS Persistence](../../../src/platform/persistence/AGENTS.md) e decisões pertinentes de [arquitetura](../../../ARCHITECTURE.md). Consulte apenas regras atingidas de [Financial](../../../docs/domain/financial.md), [Wagering](../../../docs/domain/wagering.md) ou [Messaging](../../../docs/domain/messaging.md).
2. Relacione cada invariante à constraint/índice/controle transacional que a sustenta. Não exponha tipos ORM ao domínio/aplicação nem faça Platform importar módulos.
3. Implemente mappings/adapters no escopo correto, com repositórios vinculados à mesma transação. Migrations devem ser versionadas e reversíveis; explicite riscos sobre dados, sem apagar ledger confirmado para viabilizar rollback.
4. No PostgreSQL real, quando pertinente, aplique migration, tente violar integridade por acesso direto e confira rollback transacional. Valide down/up em banco descartável compatível com o cenário, incluindo dados relevantes.
5. Se locks/unicidade concorrente mudarem, acrescente processos independentes e falhas pertinentes, sem repetir verificações de outras skills.

## Verificações

Prove unicidade/não-negatividade/imutabilidade afetadas no banco, precisão na ida/volta de Money e ausência de efeitos parciais. Confira constraints e índices com consultas ao schema e cenários de violação, não apenas mocks ou snapshots do SQL.

## Evidências de conclusão

Entregue migrations/contratos alterados, versão do PostgreSQL e ambiente usado, resultados de aplicação/reversão e tentativas de violação, além de limitações de compatibilidade. Comandos existentes ficam no [AGENTS raiz](../../../AGENTS.md); não anuncie script de migrations ainda inexistente.
