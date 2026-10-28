---
name: wagering-operation
description: Implementar ou alterar BET, WIN, LOSS, REFUND, ROLLBACK, estados, referências ou replay de apostas. Use para comportamento e orquestração de operações, incluindo rejeições e reversões.
---

# Wagering operation

## Entradas

Operação/estado afetado, payloads e referências representativos, resultado esperado e contratos de transporte envolvidos.

## Procedimento

1. Leia [AGENTS Wagering](../../../src/modules/wagering/AGENTS.md) e trechos pertinentes de [wagering.md](../../../docs/domain/wagering.md). Use [arquitetura](../../../ARCHITECTURE.md) para orquestração/transação.
2. Descreva aceitação por estado, referência, efeito financeiro, replay, falha e evento. Confira pendências antes de assumir semântica para zero, cadeias de reversão ou estados de referência.
3. Implemente por ProcessWagerUseCase compartilhado HTTP/SQS e contratos públicos de Financial; consulte [financial.md](../../../docs/domain/financial.md) apenas no efeito financeiro afetado.
4. Exercite transições válidas/proibidas, referência ausente/resolvida/incompatível, rejeição sem efeitos e replay com saldo original. Se a mudança afetar concorrência, valide duplicatas/reversões simultâneas.
5. Confira eventos esperados e ausência de publicação/efeitos indevidos usando o contrato pertinente de [messaging.md](../../../docs/domain/messaging.md).

## Verificações

Não reabra estados terminais nem use saldo atual como resposta histórica. Diferencie payload conflitante de replay; insuficiência de reversão de insuficiência BET. Preserve a reversão integral e unicidade por tipo exigidas, sem ampliar regras por suposição.

## Evidências de conclusão

Registre casos de sucesso/rejeição/pendência/replay cobertos, efeitos em saldo/ledger/eventos e verificações executadas. Cite pendências não resolvidas e atualização contratual necessária. Use os comandos reais do [AGENTS raiz](../../../AGENTS.md) em plano único.
