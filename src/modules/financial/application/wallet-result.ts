import type { Wallet } from '../domain/wallet.js';
import type { WalletResult } from '../public/wallet-api.js';

export function walletResult(wallet: Wallet): WalletResult {
	return {
		id: wallet.id,
		playerId: wallet.playerId,
		currency: wallet.currency,
		balance: wallet.balance.toProps(),
		version: wallet.version,
		createdAt: wallet.createdAt.toISOString(),
		updatedAt: wallet.updatedAt.toISOString(),
	};
}
