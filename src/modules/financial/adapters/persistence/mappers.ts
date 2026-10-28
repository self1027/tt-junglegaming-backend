import type { InferEntity } from '@mikro-orm/core';
import type {
	WalletRow,
	WalletLedgerEntryRow,
} from '../../../../platform/persistence/models.js';
import { Money } from '../../domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';

export const walletMapper = {
	toDomain(row: InferEntity<typeof WalletRow>): Wallet {
		return Wallet.rehydrate({
			id: row.id,
			playerId: row.playerId,
			currency: row.currency,
			balance: Money.rehydrate({
				amount: row.balance,
				currency: row.currency,
			}),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});
	},
	toRow(wallet: Wallet): InferEntity<typeof WalletRow> {
		return {
			id: wallet.id,
			playerId: wallet.playerId,
			currency: wallet.currency,
			balance: wallet.balance.toProps().amount,
			version: wallet.version,
			createdAt: wallet.createdAt,
			updatedAt: wallet.updatedAt,
		};
	},
};

export const ledgerMapper = {
	toDomain(row: InferEntity<typeof WalletLedgerEntryRow>): WalletLedgerEntry {
		return WalletLedgerEntry.rehydrate({
			id: row.id,
			walletId: row.walletId,
			transactionId: row.transactionId,
			direction: row.direction,
			amount: Money.rehydrate({
				amount: row.amount,
				currency: row.currency,
			}),
			balanceBefore: Money.rehydrate({
				amount: row.balanceBefore,
				currency: row.currency,
			}),
			balanceAfter: Money.rehydrate({
				amount: row.balanceAfter,
				currency: row.currency,
			}),
			createdAt: row.createdAt,
		});
	},
	toRow(entry: WalletLedgerEntry): InferEntity<typeof WalletLedgerEntryRow> {
		return {
			id: entry.id,
			walletId: entry.walletId,
			transactionId: entry.transactionId,
			direction: entry.direction,
			currency: entry.amount.currency,
			amount: entry.amount.toProps().amount,
			balanceBefore: entry.balanceBefore.toProps().amount,
			balanceAfter: entry.balanceAfter.toProps().amount,
			createdAt: entry.createdAt,
		};
	},
};
