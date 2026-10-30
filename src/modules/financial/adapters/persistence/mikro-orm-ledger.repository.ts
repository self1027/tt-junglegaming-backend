import { WalletLedgerEntryRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import type { WalletLedgerRepository } from '../../public/persistence.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { ledgerMapper } from './mappers.js';

export class MikroOrmLedgerRepository implements WalletLedgerRepository {
	constructor(private readonly session: TransactionSession) {}

	async append(entry: WalletLedgerEntry): Promise<void> {
		await this.session.em.insert(
			WalletLedgerEntryRow,
			ledgerMapper.toRow(entry),
		);
	}

	async findByWalletId(
		walletId: string,
		page?: { readonly afterId?: string; readonly limit: number },
	): Promise<readonly WalletLedgerEntry[]> {
		// Anchor by the immutable row, retaining PostgreSQL timestamp microseconds.
		if (page !== undefined) {
			const ids = await this.session.em.execute<{ id: string }[]>(
				`select id from wallet_ledger_entries where wallet_id = ? ${page.afterId === undefined ? '' : 'and (created_at, id) > (select created_at, id from wallet_ledger_entries where wallet_id = ? and id = ?)'} order by created_at, id limit ?`,
				page.afterId === undefined
					? [walletId, page.limit]
					: [walletId, walletId, page.afterId, page.limit],
			);
			const rows = await this.session.em.find(
				WalletLedgerEntryRow,
				{ id: { $in: ids.map(row => row.id) } },
				{ orderBy: { createdAt: 'asc', id: 'asc' } },
			);
			return rows.map(row => ledgerMapper.toDomain(row));
		}
		const rows = await this.session.em.find(
			WalletLedgerEntryRow,
			{ walletId },
			{ orderBy: { createdAt: 'asc', id: 'asc' } },
		);
		return rows.map(row => ledgerMapper.toDomain(row));
	}
}
