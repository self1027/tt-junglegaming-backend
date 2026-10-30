import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../../src/modules/wagering/application/process-wager.use-case.js';
import { ResolvePendingWagerUseCase } from '../../src/modules/wagering/application/resolve-pending-wager.use-case.js';
import { ReconcileWalletUseCase } from '../../src/modules/financial/application/reconcile-wallet.use-case.js';
import { MikroOrmPendingWagerStore } from '../../src/modules/wagering/adapters/persistence/mikro-orm-pending.repository.js';
import type { PendingWagerClaim } from '../../src/modules/wagering/public/pending.js';
import type { ProcessWagerCommand } from '../../src/modules/wagering/public/process-wager.js';
import type { Wallet } from '../../src/modules/financial/public/index.js';
import { openWallet } from './financial.js';

export function pendingCommand(
	wallet: { id: string; playerId: string },
	overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
	const id = crypto.randomUUID();
	return {
		providerId: 'provider',
		externalTransactionId: id,
		idempotencyKey: id,
		walletId: wallet.id,
		playerId: wallet.playerId,
		roundId: 'round',
		gameId: 'game',
		kind: 'BET',
		amount: { amount: '80.00', currency: 'BRL' },
		...overrides,
	};
}

export async function seedPending(
	orm: MikroORM,
	amount = '100.00',
	kind: 'REFUND' | 'ROLLBACK' = 'REFUND',
	referenceKind: 'BET' | 'WIN' = 'BET',
	operationAmount = '80.00',
): Promise<{
	wallet: Wallet;
	original: ProcessWagerCommand;
	pending: ProcessWagerCommand;
	id: string;
}> {
	const uow = createUnitOfWork(orm);
	const wallet = await uow.execute(context => openWallet(context, amount));
	const original = pendingCommand(wallet, {
		kind: referenceKind,
		amount: { amount: operationAmount, currency: 'BRL' },
	});
	const pending = pendingCommand(wallet, {
		kind,
		amount: { amount: operationAmount, currency: 'BRL' },
		referenceExternalTransactionId: original.externalTransactionId,
	});
	const result = await new ProcessWagerUseCase(uow).execute(pending);
	expect(result.status).toBe('PENDING_REFERENCE');
	return { wallet, original, pending, id: result.transactionId };
}

export async function seedNeutralizedRollback(
	orm: MikroORM,
): ReturnType<typeof seedPending> {
	const f = await seedPending(orm, '100.00', 'ROLLBACK');
	const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
	const refund = pendingCommand(f.wallet, {
		kind: 'REFUND',
		referenceExternalTransactionId: f.original.externalTransactionId,
	});
	for (const command of [
		f.original,
		refund,
		pendingCommand(f.wallet, {
			kind: 'ROLLBACK',
			referenceExternalTransactionId: refund.externalTransactionId,
		}),
	])
		expect((await uc.execute(command)).status).toBe('PROCESSED');
	await reconciled(orm, f.wallet.id, '20.00', 4);
	return f;
}

export async function pendingClaim(
	orm: MikroORM,
	id: string,
	leaseMs = 30000,
): Promise<PendingWagerClaim> {
	await orm.em.execute(
		"update wager_transactions set next_attempt_at = clock_timestamp() + interval '1 day' where status in ('PENDING', 'PENDING_REFERENCE') and claim_token is null",
	);
	await orm.em.execute(
		'update wager_transactions set next_attempt_at = clock_timestamp() where id = ?',
		[id],
	);
	const claims = await new MikroOrmPendingWagerStore(orm.em).claim(
		1,
		'test',
		leaseMs,
	);
	const claim = claims[0];
	if (claim?.transaction.id !== id)
		throw new Error('Missing expected pending claim');
	return claim;
}

export async function resolvePending(
	orm: MikroORM,
	id: string,
	ttlMs = 86400000,
): Promise<string> {
	const claim = await pendingClaim(orm, id);
	return new ResolvePendingWagerUseCase(createUnitOfWork(orm), ttlMs).execute(
		claim,
		1000,
	);
}

export async function reconciled(
	orm: MikroORM,
	walletId: string,
	amount: string,
	version: number,
): Promise<void> {
	const uow = createUnitOfWork(orm);
	const wallet = await uow.execute(context =>
		context.wallets.findById(walletId),
	);
	expect(wallet?.balance.toProps().amount).toBe(amount);
	expect(wallet?.version).toBe(version);
	const result = await new ReconcileWalletUseCase(uow).execute(walletId);
	expect(result.consistent).toBe(true);
	expect(result.calculatedBalance.amount).toBe(amount);
}

export async function pendingUntil(
	check: () => Promise<boolean>,
	label: string,
	timeout = 10000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(20);
	}
	throw new Error(`Pending worker timed out: ${label}`);
}
