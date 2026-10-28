---
name: reliable-messaging
description: Implementar ou revisar Consumer, Inbox, Outbox, publicação, ACK, redelivery ou DLQ. Use quando o resultado central alterar entrega, deduplicação de transporte ou recuperação de mensagens/eventos.
---

# Reliable messaging

## Entradas

Fluxo/envelope afetado, identidades de mensagem/evento, fronteira de commit e falhas que a mudança deve suportar.

## Procedimento

1. Leia [AGENTS Messaging](../../../src/platform/messaging/AGENTS.md), trechos relevantes de [messaging.md](../../../docs/domain/messaging.md) e a fronteira transacional de [arquitetura](../../../ARCHITECTURE.md).
2. Marque os pontos receber, persistir, commit, publicar, marcar publicado e ACK. Diferencie Inbox/idempotência de negócio; não presuma que FIFO garante efeitos únicos.
3. Implemente a mudança preservando a transação compartilhada e eventId em republicações. Mantenha Outbox Publisher separado do processamento de referências.
4. Exercite as janelas de falha afetadas: antes/depois do commit, antes do ACK, publicação com confirmação incerta, SIGTERM e indisponibilidade. Valide retry/DLQ conforme política documentada, sem inventar limites.
5. Se a garantia depender de múltiplas instâncias, complemente [distributed-validation](../distributed-validation/SKILL.md) e reúna os checks em um plano.

## Verificações

ACK/publicação respeitam commit; efeitos não duplicam no redelivery; eventos confirmados sobrevivem ao crash; erro de negócio/transitório/permanente segue destino correto. Publishers concorrentes recuperam trabalho sem perda ou duplicação indefinida. Use PostgreSQL/SQS reais quando a conclusão depender deles.

## Evidências de conclusão

Informe a janela de falha exercitada, registros/identificadores correlacionáveis sem payload sensível, resultados de redelivery/recuperação e comandos executados. Registre limitações e pendências; comandos gerais no [AGENTS raiz](../../../AGENTS.md).
