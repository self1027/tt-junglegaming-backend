---
name: financial-change
description: Implementar ou revisar mudanças em Money, Wallet, saldo, ledger, abertura ou reconciliação. Use quando o resultado central modificar comportamento financeiro ou suas invariantes.
---

# Financial change

## Entradas

Comportamento financeiro afetado, exemplos de entrada/resultado e fronteira transacional existente ou planejada. Identifique decisões monetárias ainda não aprovadas.

## Procedimento

1. Leia [AGENTS Financial](../../../src/modules/financial/AGENTS.md) e somente os contratos afetados em [financial.md](../../../docs/domain/financial.md). Confira [arquitetura](../../../ARCHITECTURE.md) se houver impacto em transação/dependências.
2. Relacione mudança às invariantes monetárias, saldo, versão e ledger. Use a tabela de [Wagering](../../../docs/domain/wagering.md) apenas se a tarefa alterar operações/reversões.
3. Implemente preservando encapsulamento e participação na transação recebida. Não resolva representação Money/ORM pendente por suposição.
4. Defina e execute casos de precisão/entradas/moedas e efeitos ou ausência de efeitos pertinentes. Se houver persistência, comprove atomicidade e reconstrução do saldo; se houver risco de race, acrescente validação concorrente real.

## Verificações

- Sem conversão financeira por number/float/double ou arredondamento não definido.
- Saldo, versão e ledger consistentes no sucesso, falha e replay quando afetados.
- Sem lançamento mutado nem transação financeira independente dentro da unidade recebida.
- Garantias dependentes de banco/concorrência têm evidência real, sem executar distribuídos para mudanças sem esse impacto.

## Evidências de conclusão

Informe invariantes/casos cobertos, comandos e resultados, efeitos observados e limitações. Atualize o contrato principal somente quando necessário, mantendo rastreabilidade às seções originais. Comandos gerais: [AGENTS raiz](../../../AGENTS.md).
