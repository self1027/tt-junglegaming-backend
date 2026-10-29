import type { PendingWagerClaim } from '../public/pending.js';
import type { WageringUnitOfWork } from '../public/persistence.js';
import { processWager, saveWagerBalanceChange } from './process-wager.js';
import { wagerEvents } from './wager-events.js';

export class ResolvePendingWagerUseCase {
	constructor(
		private readonly unitOfWork: WageringUnitOfWork,
		private readonly ttlMs: number,
	) {}

	async execute(
		claim: PendingWagerClaim,
		delayMs: number,
	): Promise<'PROCESSED' | 'REJECTED' | 'WAITING' | 'CLAIM_LOST'> {
		return this.unitOfWork.execute(async context => {
			if (context.pending === undefined)
				throw new Error('Pending resolution is not configured');
			const original = claim.transaction;
			const scope = `wagering:v1:${JSON.stringify(original.providerId)}`;
			const previous = await context.idempotency.lockResult(
				scope,
				original.idempotencyKey,
				original.payloadHash,
				original.id,
			);
			if (previous === undefined)
				throw new Error('Missing pending idempotency result');
			if (
				previous.status !== 'PENDING' &&
				previous.status !== 'PENDING_REFERENCE'
			)
				return 'CLAIM_LOST';
			await context.transactions.lockExternalIdentity(
				original.providerId,
				original.externalTransactionId,
			);
			const wallet = await context.wallets.lockById(original.walletId);
			if (wallet === undefined) throw new Error('Missing pending wallet');
			const locked = await context.pending.lock(claim, this.ttlMs);
			if (locked === undefined) return 'CLAIM_LOST';
			const { transaction, expired } = locked;
			const at = new Date(
				Math.max(
					locked.at.getTime(),
					wallet.updatedAt.getTime(),
					transaction.createdAt.getTime(),
				),
			);
			const { result, change } = await processWager(
				transaction,
				wallet,
				context,
				at,
				expired,
			);
			if (
				result.status === 'PENDING' ||
				result.status === 'PENDING_REFERENCE'
			) {
				await context.pending.finish(
					claim,
					transaction,
					delayMs,
					result.pendingReference.reason,
				);
				return 'WAITING';
			}
			await saveWagerBalanceChange(
				transaction,
				wallet,
				context,
				change,
				at,
			);
			await context.idempotency.resolvePending(
				scope,
				original.idempotencyKey,
				original.payloadHash,
				result,
			);
			await context.outbox.append(
				wagerEvents(transaction, wallet, change, at),
			);
			await context.pending.finish(
				claim,
				transaction,
				delayMs,
				undefined,
			);
			return result.status === 'PROCESSED' ? 'PROCESSED' : 'REJECTED';
		});
	}
}
