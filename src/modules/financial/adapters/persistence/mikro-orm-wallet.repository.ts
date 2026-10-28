import { LockMode } from '@mikro-orm/core';
import { WalletRow } from '../../../../platform/persistence/models.js';
import type { TransactionSession } from '../../../../platform/persistence/transaction-session.js';
import type { WalletRepository } from '../../public/persistence.js';
import type { Wallet } from '../../domain/wallet.js';
import { walletMapper } from './mappers.js';

export class MikroOrmWalletRepository implements WalletRepository {
	private readonly locked = new Map<
		string,
		{ wallet: Wallet; version: number }
	>();

	constructor(private readonly session: TransactionSession) {}

	async findById(id: string): Promise<Wallet | undefined> {
		const row = await this.session.em.findOne(
			WalletRow,
			{ id },
			{ refresh: true },
		);
		return row === null ? undefined : walletMapper.toDomain(row);
	}

	async findByPlayerAndCurrency(
		playerId: string,
		currency: string,
	): Promise<Wallet | undefined> {
		const row = await this.session.em.findOne(
			WalletRow,
			{ playerId, currency },
			{ refresh: true },
		);
		return row === null ? undefined : walletMapper.toDomain(row);
	}

	async lockById(id: string): Promise<Wallet | undefined> {
		const em = this.session.em;
		const held = this.locked.get(id);
		if (held !== undefined) return held.wallet;
		const row = await em.findOne(
			WalletRow,
			{ id },
			{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
		);
		if (row === null) return undefined;
		const wallet = walletMapper.toDomain(row);
		this.locked.set(id, { wallet, version: wallet.version });
		return wallet;
	}

	async insert(wallet: Wallet): Promise<void> {
		await this.session.em.insert(WalletRow, walletMapper.toRow(wallet));
	}

	async save(wallet: Wallet): Promise<void> {
		const em = this.session.em;
		const held = this.locked.get(wallet.id);
		if (held?.wallet !== wallet) {
			throw new Error(
				'Wallet must be acquired by lockById in this transaction',
			);
		}
		if (held.version === wallet.version) return;
		const row = walletMapper.toRow(wallet);
		const affected = await em.nativeUpdate(
			WalletRow,
			{ id: wallet.id, version: held.version },
			{
				balance: row.balance,
				version: row.version,
				updatedAt: row.updatedAt,
			},
		);
		if (affected !== 1) throw new Error('Wallet version conflict');
		held.version = wallet.version;
	}
}
