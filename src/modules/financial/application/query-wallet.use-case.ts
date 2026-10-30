import { isUuid } from '../domain/state-validation.js';
import type { UnitOfWork } from '../public/persistence.js';
import { FinancialApplicationError } from '../public/wallet-api.js';
import type { WalletResult } from '../public/wallet-api.js';
import { walletResult } from './wallet-result.js';

export class QueryWalletUseCase {
	constructor(private readonly unitOfWork: UnitOfWork) {}

	async execute(walletId: string): Promise<WalletResult> {
		return this.unitOfWork.execute(
			async context => {
				const wallet = await context.wallets.findById(walletId);
				if (wallet === undefined)
					throw new FinancialApplicationError('WALLET_NOT_FOUND');
				return walletResult(wallet);
			},
			{ readOnly: true },
		);
	}

	async ledger(
		walletId: string,
		page: { cursor?: string | undefined; limit: number },
	): Promise<{
		items: readonly Record<string, unknown>[];
		nextCursor: string | null;
	}> {
		let afterId: string | undefined;
		if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100)
			throw new FinancialApplicationError('INVALID_CURSOR');
		if (page.cursor !== undefined) {
			try {
				const decoded: unknown = JSON.parse(
					atob(page.cursor.replaceAll('-', '+').replaceAll('_', '/')),
				);
				if (
					!Array.isArray(decoded) ||
					decoded.length !== 2 ||
					decoded[0] !== walletId ||
					typeof decoded[1] !== 'string' ||
					!isUuid(decoded[1])
				)
					throw new Error('Invalid cursor');
				afterId = decoded[1];
			} catch {
				throw new FinancialApplicationError('INVALID_CURSOR');
			}
		}
		return this.unitOfWork.execute(
			async context => {
				if ((await context.wallets.findById(walletId)) === undefined)
					throw new FinancialApplicationError('WALLET_NOT_FOUND');
				const entries = await context.ledger.findByWalletId(walletId, {
					...(afterId === undefined ? {} : { afterId }),
					limit: page.limit + 1,
				});
				const items = entries.slice(0, page.limit).map(entry => ({
					id: entry.id,
					walletId: entry.walletId,
					transactionId: entry.transactionId,
					direction: entry.direction,
					money: entry.amount.toProps(),
					balanceBefore: entry.balanceBefore.toProps(),
					balanceAfter: entry.balanceAfter.toProps(),
					createdAt: entry.createdAt.toISOString(),
				}));
				const last = entries[page.limit - 1];
				return {
					items,
					nextCursor:
						entries.length > page.limit && last !== undefined
							? btoa(JSON.stringify([walletId, last.id]))
									.replaceAll('+', '-')
									.replaceAll('/', '_')
									.replaceAll('=', '')
							: null,
				};
			},
			{ readOnly: true },
		);
	}
}
