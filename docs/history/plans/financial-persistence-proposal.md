> HISTORICAL: registro da etapa indicada. Estado atual em [docs/index](../../index.md).

# Proposta de abertura para a integração financeira

Registrada antes da implementação, conforme §10 da tarefa Financial Persistence Integration.

`Wallet.create` continuará criando exclusivamente saldo zero e versão 1. Adicionar
`Wallet.open({ id, playerId, currency, createdAt, initialBalance })`, validando Money,
moeda, saldo não negativo, identidades e datas com as mesmas invariantes estruturais.
A nova factory inicia o saldo informado com versão 1; não chama `credit` nem
reinterpreta `rehydrate` como API de abertura.

O futuro caso de uso deverá persistir wallet, registro interno OPENING e ledger
CREDIT na mesma unidade de trabalho quando o saldo for positivo. Zero não exige
transação ou ledger. A factory sozinha não promete persistência nem atomicidade.

Esta evolução está autorizada condicionalmente pelo §10 da tarefa atual, que exige
documentar a proposta antes de implementá-la. Não inclui endpoint ou caso de uso.
O contrato definitivo e as evidências ficarão em [Financial](../../domain/financial.md)
e [persistência](../../persistence.md), preservando o [enunciado](../../challenge.md).
