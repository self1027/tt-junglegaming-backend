# Messaging

Escopo: transporte e mecanismos técnicos de mensageria. Contrato: [messaging.md](../../../docs/domain/messaging.md); composição e portas: [ARCHITECTURE.md](../../../ARCHITECTURE.md).

- Separe recebimento e processamento; delegue o negócio pelo contrato composto no bootstrap, sem Platform importar módulos.
- Preserve Inbox persistente, deduplicação de redelivery e ACK somente após commit.
- Preserve Outbox transacional e publicação após commit; falhas entre publicar/marcar podem exigir republicação com identificador estável.
- Mantenha recuperação, retry/DLQ e shutdown verificáveis; não confunda deduplicação de mensagem com idempotência de negócio.
- Use [reliable-messaging](../../../.agents/skills/reliable-messaging/SKILL.md). Consulte [distributed-validation](../../../.agents/skills/distributed-validation/SKILL.md) se precisar comprovar garantias entre processos.

Consumer, Inbox e ACK estão implementados; publisher com claims/lease/fencing está implementado; worker de referências permanece futuro. Receba uma mensagem por chamada, com pollers concorrentes limitados, para não gastar tentativas das sucessoras de uma mensagem inválida. Comprove as janelas de falha afetadas. [Operação](../../../docs/sqs-consumer.md).

Publisher: preserve [protocolo](../../../docs/outbox-publisher.md), envelope histórico e fila distinta. Não mantenha transação SQL durante rede. Attempts conta claims confirmados; token e lease válido condicionam toda conclusão/retry. Erros permanentes permanecem recuperáveis, sem descarte.
