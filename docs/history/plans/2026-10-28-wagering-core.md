> HISTORICAL: registro da etapa indicada. Estado atual em [docs/index](../../index.md).

# Wagering Core Implementation Plan

**Goal:** implementar exclusivamente domínio Wagering e unidade conforme a tarefa Wagering Domain Core & State Machine e [contrato](../../domain/wagering.md).

**Architecture:** entidade pura com Money público de Financial; avaliação sem efeitos e transições explícitas. Nenhum caso de uso, mapper, adapter ou migration novo.

**Tech Stack:** TypeScript strict, Bun 1.4.4 e testes reais de domínio sem infraestrutura.

## Restrições e aceitação

- Preservar challenge.md, schema, arquitetura e testes negativos.
- Estados terminais protegidos; reidratação estrutural sem transições nem efeitos.
- Referência ausente difere de encontrada não processada e de incompatível.
- Zero financeiro e reversão entre modalidades ficam sem autorização financeira enquanto o contrato estiver ambíguo. LOSS não movimenta saldo, inclusive com zero.
- Histórico completo de reversões é entrada fornecida pelo chamador; unicidade concorrente depende do banco.
- failureCode é opaco e fornecido pelo chamador, sem taxonomia externa nova.

## Etapas (execução nesta sessão)

1. [x] Escrever testes em test/wager-transaction.test.ts: criação PENDING, identidades obrigatórias, rehydrate de todos os estados, mutação e terminalidade. Implementar errors.ts, wager-types.ts e wager-transaction.ts em src/modules/wagering/domain e exports em public/index.ts; executar testes.
2. [x] Escrever testes de processingDecision(reference?) e markProcessed(at, reference?): BET DEBIT, WIN CREDIT, LOSS NONE; referências/contexto/valor; REFUND de BET, ROLLBACK de BET/WIN/REFUND; pendência, duplicação e políticas não resolvidas. Implementar e validar.
3. [x] Atualizar docs/domain/wagering.md com API, matrizes, decisões locais, ambiguidades e divergências de persistência. Conferir links e enunciado inalterado.
4. [x] Executar typecheck, lint (inclui arquitetura), format:check, test e build; revisar alteração e tentar atualizar Graphify, registrando limitações reais.

## Foco da revisão

- UUIDs com caixa diferente não podem contornar autocitação/identidade.
- Falhas de validação preservam status, referência, data e failureCode.
- Estado persistido pode conter zero histórico; rehydrate não aplica política de novas operações.
- Histórico de outra referência nunca autoriza reversão; snapshots unitários não provam concorrência.
- Datas retornadas e entradas mutáveis não podem alterar a entidade.

## Evidências

Consulta Graphify inicial e reformulada (`ProcessedWagerRecord`) e atualização falharam: executável graphify ausente. Bun encontrado em C:/Users/MuriloD/.bun/bin. Fallback restrito localizou contratos públicos, Money/Wallet, adapter técnico e migration inicial; nenhum índice foi tratado como atual.

Testes escritos antes do domínio: execução inicial falhou por entrada pública ainda inexistente (erro de importação, não falha de asserção comportamental); após implementação, 55/55 passaram, também verificados por revisor independente. Não se declara ciclo RED comportamental isolado por método.

Validação final: 179/179 testes, 1130 asserções; typecheck/lint/format:check/build aprovados. Dependências instaladas com lockfile congelado; Docker iniciado para a suíte existente. Revisão independente sem achado bloqueante. Geração/atualização Graphify não disponíveis por CLI ausente; demais evidências no contrato Wagering.
