# Observability

Escopo: logs, métricas e health técnicos. Contratos explícitos: §§9 e 12, indexados em [requirements.md](../../../docs/requirements.md). Siga as fronteiras de [ARCHITECTURE.md](../../../ARCHITECTURE.md).

- Preserve logs JSON estruturados e correlação das operações, sem segredos, dados sensíveis ou payload financeiro completo.
- Preserve métricas obrigatórias e sinalização de divergência; não esconda falhas para produzir status saudável.
- Separe liveness de readiness; health é aberto. Liveness não consulta dependências. Readiness verifica PostgreSQL, mas permanece 503 enquanto SQS não estiver configurado; não anuncie readiness completo nesta etapa.
- Controllers adaptam protocolo e delegam; não contenham regras de negócio. Platform não importa módulos.
- Para investigação use [operational-diagnosis](../../../.agents/skills/operational-diagnosis/SKILL.md); registre hipóteses e evidências, sem ajustar saldo ou reenviar operação silenciosamente.

Valide o sinal afetado e sua correlação, inclusive indisponibilidade quando pertinente; não exija infraestrutura distribuída para alteração exclusiva de apresentação de um log.
