import { WagerTransaction } from '../domain/wager-transaction.js';
import { processWager, saveWagerBalanceChange } from './process-wager.js';
import type {
	WageringTransactionContext,
	WageringUnitOfWork,
} from '../public/persistence.js';
import { WagerApplicationError } from '../public/process-wager.js';
import type {
	ProcessWagerCommand,
	ProcessWagerResult,
} from '../public/process-wager.js';
import { prepareWager } from './canonical-wager.js';
import { wagerEvents } from './wager-events.js';
import type { InboxDelivery } from '../public/inbox.js';

export class ProcessWagerUseCase {
	constructor(private readonly unitOfWork: WageringUnitOfWork) {}

	execute(command: ProcessWagerCommand): Promise<ProcessWagerResult>;
	execute(
		command: ProcessWagerCommand,
		delivery: InboxDelivery,
	): Promise<ProcessWagerResult | undefined>;
	async execute(
		command: ProcessWagerCommand,
		delivery?: InboxDelivery,
	): Promise<ProcessWagerResult | undefined> {
		const prepared = await prepareWager(command);
		const scope = `wagering:v1:${JSON.stringify(prepared.providerId)}`;
		const apply = async (
			context: WageringTransactionContext,
		): Promise<ProcessWagerResult> => {
			const claim = await context.idempotency.claim(
				scope,
				prepared.idempotencyKey,
				prepared.payloadHash,
			);
			if (claim.type === 'EXISTING') {
				if (claim.payloadHash !== prepared.payloadHash)
					throw new WagerApplicationError('IDEMPOTENCY_CONFLICT');
				if (claim.result === undefined)
					throw new WagerApplicationError('IDEMPOTENCY_IN_PROGRESS');
				if (
					prepared.walletId !== undefined &&
					prepared.walletId !== claim.result.walletId
				)
					throw new WagerApplicationError('WALLET_NOT_FOUND');
				return { ...claim.result, idempotentReplay: true };
			}
			await context.transactions.lockExternalIdentity(
				prepared.providerId,
				prepared.externalTransactionId,
			);
			const existing = await context.transactions.findByExternalIdentity(
				prepared.providerId,
				prepared.externalTransactionId,
			);
			if (existing !== undefined)
				throw new WagerApplicationError(
					'EXTERNAL_TRANSACTION_CONFLICT',
					existing.id,
					existing.matchesPayload(prepared.payloadHash),
				);
			const resolved = await context.wallets.findByPlayerAndCurrency(
				prepared.playerId,
				prepared.money.currency,
			);
			if (
				resolved === undefined ||
				(prepared.walletId !== undefined &&
					prepared.walletId !== resolved.id)
			)
				throw new WagerApplicationError('WALLET_NOT_FOUND');
			const wallet = await context.wallets.lockById(resolved.id);
			if (wallet === undefined)
				throw new WagerApplicationError('WALLET_NOT_FOUND');
			const at = new Date(
				Math.max(Date.now(), wallet.updatedAt.getTime()),
			);
			const transaction = WagerTransaction.create({
				...prepared,
				id: crypto.randomUUID(),
				walletId: wallet.id,
				createdAt: at,
			});
			const { result, change } = await processWager(
				transaction,
				wallet,
				context,
				at,
			);
			await context.transactions.insert(transaction);
			await saveWagerBalanceChange(
				transaction,
				wallet,
				context,
				change,
				at,
			);
			await context.outbox.append(
				wagerEvents(transaction, wallet, change, at),
			);
			await context.idempotency.complete(
				scope,
				prepared.idempotencyKey,
				prepared.payloadHash,
				result,
			);
			return result;
		};
		return this.unitOfWork.execute(async context => {
			if (delivery !== undefined) {
				if (context.inbox === undefined)
					throw new Error('Inbox participation is not configured');
				if ((await context.inbox.claim(delivery)) === 'PROCESSED')
					return undefined;
			}
			const result = await apply(context);
			if (delivery !== undefined) await context.inbox?.complete(delivery);
			return result;
		});
	}
}
