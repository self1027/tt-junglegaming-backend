# Messaging

Escopo: transporte e mecanismos técnicos de mensageria. Contrato: [messaging.md](../../../docs/domain/messaging.md); composição e portas: [ARCHITECTURE.md](../../../ARCHITECTURE.md).

- Separe recebimento e processamento; delegue o negócio pelo contrato composto no bootstrap, sem Platform importar módulos.
- Preserve Inbox persistente, deduplicação de redelivery e ACK somente após commit.
- Preserve Outbox transacional e publicação após commit; falhas entre publicar/marcar podem exigir republicação com identificador estável.
- Mantenha recuperação, retry/DLQ e shutdown verificáveis; não confunda deduplicação de mensagem com idempotência de negócio.
- Use [reliable-messaging](../../../.agents/skills/reliable-messaging/SKILL.md). Consulte [distributed-validation](../../../.agents/skills/distributed-validation/SKILL.md) se precisar comprovar garantias entre processos.

Consumer, Inbox e ACK estão implementados; publisher e worker de referências permanecem futuros. Receba uma mensagem por chamada, com pollers concorrentes limitados, para não gastar tentativas das sucessoras de uma mensagem inválida. Comprove as janelas de falha afetadas. [Operação](../../../docs/sqs-consumer.md).
