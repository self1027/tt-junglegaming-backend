import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { UnitOfWork } from '../public/persistence.js';
import { FinancialApplicationError } from '../public/wallet-api.js';
import type {
	CreateWalletCommand,
	WalletResult,
} from '../public/wallet-api.js';
import { walletResult } from './wallet-result.js';

export class CreateWalletUseCase {
	constructor(private readonly unitOfWork: UnitOfWork) {}

	async execute(command: CreateWalletCommand): Promise<WalletResult> {
		if (
			typeof command.playerId !== 'string' ||
			command.playerId.trim() === '' ||
			command.playerId.includes('\0') ||
			/[\uD800-\uDFFF]/u.test(command.playerId)
		)
			throw new FinancialApplicationError('INVALID_WALLET_INPUT');
		const initialBalance = Money.create(command.initialBalance);
		const at = new Date();
		const wallet = Wallet.open({
			id: crypto.randomUUID(),
			playerId: command.playerId,
			currency: initialBalance.currency,
			initialBalance,
			createdAt: at,
		});
		return this.unitOfWork.execute(async context => {
			await context.wallets.insert(wallet);
			if (initialBalance.isPositive()) {
				const transactionId = crypto.randomUUID();
				await context.openings.insert({
					id: transactionId,
					walletId: wallet.id,
					playerId: wallet.playerId,
					money: initialBalance,
					createdAt: at,
				});
				await context.ledger.append(
					WalletLedgerEntry.create({
						id: crypto.randomUUID(),
						transactionId,
						walletId: wallet.id,
						direction: 'CREDIT',
						amount: initialBalance,
						balanceBefore: Money.zero(wallet.currency),
						balanceAfter: initialBalance,
						createdAt: at,
					}),
				);
			}
			return walletResult(wallet);
		});
	}
}
