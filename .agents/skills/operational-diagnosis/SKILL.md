---
name: operational-diagnosis
description: Investigar divergências financeiras, eventos atrasados, mensagens duplicadas, falhas de processamento ou sinais de observabilidade. Use para produzir diagnóstico com hipóteses e evidências antes de remediar.
---

# Operational diagnosis

## Entradas

Sintoma, janela de tempo/fuso, ambiente/versão, IDs de correlação/operação e evidências disponíveis. Procure informações já acessíveis antes de pedir dados ausentes.

## Procedimento

1. Leia [AGENTS Observability](../../../src/platform/observability/AGENTS.md) e requisitos de sinais em [requirements.md](../../../docs/requirements.md). Localize processos/dependências em [arquitetura](../../../ARCHITECTURE.md).
2. Registre hipóteses testáveis, evidências a favor/contra e lacunas; não atribua causa apenas por correlação temporal.
3. Colete logs/métricas/estados de forma preferencialmente read-only e sem segredos ou payload financeiro completo. Reconstrua linha do tempo por IDs.
4. Para divergência financeira consulte [financial.md](../../../docs/domain/financial.md) e compare ledger/materializado; para operação consulte [wagering.md](../../../docs/domain/wagering.md); para atraso/duplicata consulte [messaging.md](../../../docs/domain/messaging.md) e pontos de commit/ACK/publicação.
5. Proponha a menor correção sustentada pelas evidências, com validação e recuperação proporcionais. Execute remediação somente no escopo autorizado, de forma explícita e auditável; não corrija saldos nem reenvie operações silenciosamente.

## Verificações

Distinga duplicata de entrega, replay e duplicação financeira. Diferencie indisponibilidade, pendência de referência e falha terminal; confira liveness/readiness separadamente. Não use ausência de log como prova de ausência de commit.

## Evidências de conclusão

Entregue sintoma, hipóteses confirmadas/refutadas, consultas/medições com janela temporal, causa sustentada ou incerteza restante e remediações executadas/propostas. Não exponha dados sensíveis; registre checks e limitações conforme [AGENTS raiz](../../../AGENTS.md).
