import { Money } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { UnitOfWork } from '../public/persistence.js';
import { FinancialApplicationError } from '../public/wallet-api.js';
import type {
	ReconciliationDiagnostics,
	WalletReconciliationResult,
} from '../public/wallet-api.js';

export class ReconcileWalletUseCase {
	constructor(
		private readonly unitOfWork: UnitOfWork,
		private readonly diagnostics?: ReconciliationDiagnostics,
	) {}

	async execute(walletId: string): Promise<WalletReconciliationResult> {
		const result = await this.unitOfWork.execute(
			async context => {
				const wallet = await context.wallets.findById(walletId);
				if (wallet === undefined)
					throw new FinancialApplicationError('WALLET_NOT_FOUND');
				const entries = await context.ledger.findByWalletId(walletId);
				let calculated = Money.zero(wallet.currency);
				for (const entry of entries) {
					calculated =
						entry.direction === 'CREDIT'
							? calculated.add(entry.amount)
							: calculated.subtract(entry.amount);
				}
				const difference = wallet.balance.subtract(calculated);
				return {
					walletId: wallet.id,
					storedBalance: wallet.balance.toProps(),
					calculatedBalance: calculated.toProps(),
					difference: difference.toProps(),
					consistent:
						difference.isZero() &&
						continuousHistory(entries, wallet.currency),
					checkedEntries: entries.length,
				};
			},
			{ readOnly: true },
		);
		if (!result.consistent) this.diagnostics?.divergence(result.walletId);
		return result;
	}
}

function continuousHistory(
	entries: readonly WalletLedgerEntry[],
	currency: string,
): boolean {
	const groups = new Map<number, WalletLedgerEntry[]>();
	for (const entry of entries) {
		const time = entry.createdAt.getTime();
		const group = groups.get(time) ?? [];
		group.push(entry);
		groups.set(time, group);
	}
	let balance = Money.zero(currency);
	for (const [, group] of [...groups].sort(([a], [b]) => a - b)) {
		const start = balance.toProps().amount;
		const degree = new Map<string, number>();
		const neighbors = new Map<string, string[]>();
		for (const entry of group) {
			const before = entry.balanceBefore.toProps().amount;
			const after = entry.balanceAfter.toProps().amount;
			degree.set(before, (degree.get(before) ?? 0) + 1);
			degree.set(after, (degree.get(after) ?? 0) - 1);
			const from = neighbors.get(before) ?? [];
			const to = neighbors.get(after) ?? [];
			from.push(after);
			to.push(before);
			neighbors.set(before, from);
			neighbors.set(after, to);
			balance =
				entry.direction === 'CREDIT'
					? balance.add(entry.amount)
					: balance.subtract(entry.amount);
		}
		const end = balance.toProps().amount;
		// Equal timestamps have no financial ordering by UUID: require a connected Euler trail.
		for (const [value, count] of degree)
			if (count !== (value === start ? 1 : 0) - (value === end ? 1 : 0))
				return false;
		const seen = new Set<string>();
		const pending = [start];
		for (const value of pending) {
			if (seen.has(value)) continue;
			seen.add(value);
			pending.push(...(neighbors.get(value) ?? []));
		}
		if ([...neighbors.keys()].some(value => !seen.has(value))) return false;
	}
	return true;
}
