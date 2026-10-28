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
	): Promise<readonly WalletLedgerEntry[]> {
		const rows = await this.session.em.find(
			WalletLedgerEntryRow,
			{ walletId },
			{ orderBy: { createdAt: 'asc', id: 'asc' } },
		);
		return rows.map(row => ledgerMapper.toDomain(row));
	}
}
