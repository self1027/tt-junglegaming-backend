# Bootstrap

Escopo: composição NestJS e ciclo de vida em bootstrap; ao alterar os entrypoints em src, consulte também este arquivo. Siga a [arquitetura](../../ARCHITECTURE.md), especialmente processos e unidade transacional.

- Componha implementações concretas e dependências aqui, sem regras de negócio.
- Preserve entrypoints independentes e encerramento dos recursos de cada processo. Consumer está implementado sem HTTP; worker permanece futuro.
- HTTP e SQS devem compartilhar casos de uso. Não crie caminhos financeiros alternativos na inicialização.
- Ao adicionar entrypoint, confira as regras arquiteturais atuais: somente main.api.ts e main.consumer.ts têm exceção para importar bootstrap. Não amplie permissões globalmente.
- Para coordenação entre áreas, use [delivery-workflow](../../.agents/skills/delivery-workflow/SKILL.md). Não carregue regras de reversão em mudanças exclusivas de composição.

Valide os processos afetados, inicialização/encerramento e build conforme o plano da [raiz](../../AGENTS.md). O smoke test atual está em [test/api.test.ts](../../test/api.test.ts).
