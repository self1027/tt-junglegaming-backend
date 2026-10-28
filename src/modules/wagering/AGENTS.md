# Wagering

Escopo: public, domain, application e adapters de Wagering. Regras: [wagering.md](../../../docs/domain/wagering.md); orquestração: [ARCHITECTURE.md](../../../ARCHITECTURE.md).

- Preserve ProcessWagerUseCase como coordenador transacional compartilhado entre HTTP e SQS; não crie fluxo financeiro paralelo.
- Preserve estados, referências, reversões e idempotência; replay processado retorna saldo/resultado original, sem reaplicar efeitos.
- Acesse Financial somente por contratos públicos. Não abra transação financeira independente dentro da unidade de trabalho.
- Use [wagering-operation](../../../.agents/skills/wagering-operation/SKILL.md); complemente apenas nas responsabilidades realmente afetadas.

Valide a operação e seus efeitos/ausência de efeitos, falhas e eventos. Para pontos ambíguos registrados no domínio, sinalize a decisão necessária antes de codificar uma interpretação nova.
