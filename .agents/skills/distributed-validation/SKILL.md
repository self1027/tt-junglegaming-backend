---
name: distributed-validation
description: Projetar ou executar testes de concorrência entre instâncias, duplicatas, crash recovery, Outbox concorrente, redelivery e reinicialização. Use para demonstrar garantias distribuídas, não para mudanças sem esse impacto.
---

# Distributed validation

## Entradas

Garantia afetada, cenário reproduzível, recursos reais disponíveis, processos envolvidos, ponto de falha e resultado persistido esperado.

## Procedimento

1. Leia [política de testes](../../../tests/AGENTS.md) e os cenários pertinentes em [requirements.md](../../../docs/requirements.md), §§8 e 13 do original. Consulte [arquitetura](../../../ARCHITECTURE.md) para localizar fronteiras de processo/commit.
2. Escolha somente cenários afetados. Prepare PostgreSQL e LocalStack/MiniStack reais em containers quando a garantia depender desses serviços, com dados isolados e teardown garantido.
3. Inicie **pelo menos três processos independentes quando a garantia exigida depender dessa condição**; registre PIDs e responsabilidades. Promises, threads e mocks sequenciais não substituem múltiplas instâncias.
4. Coordene início/falhas com barreiras e sinais observáveis; use polling limitado por prazo justificado para conclusão, sem sleep arbitrário como prova de corrida.
5. Conforme impacto, exercite duplicatas paralelas, disputa de saldo, wallets distintas, dois publishers, referência fora de ordem, morte entre commit/ACK ou commit/publicação e reinício. Quantidades/resultados obrigatórios pertencem ao índice de requisitos.
6. Confira no armazenamento efeitos únicos, atomicidade e recuperação. Reconstrua saldo pelo ledger para fluxos financeiros e compare ao materializado.

## Verificações

Correlacione instâncias e operações; comprove o ponto real do crash e o estado antes/depois. Diferencie efeito financeiro único de publicação at-least-once. Não conclua sucesso se o cenário não conseguiu produzir a concorrência/falha planejada.

## Evidências de conclusão

Registre comando/harness utilizado, serviços/versões, PIDs, barreiras, ponto da interrupção, contagens/status finais e reconciliação. Declare cenários omitidos e razão. Scripts futuros só são documentados após existirem; comandos atuais no [AGENTS raiz](../../../AGENTS.md).
