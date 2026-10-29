import {
	InsufficientBalanceError,
	WalletLedgerEntry,
} from '../../financial/public/index.js';
import type { BalanceChange, Wallet } from '../../financial/public/index.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import type { WagerReference } from '../domain/wager-transaction.js';
import {
	IncompatibleWagerReferenceError,
	InvalidWagerReversalError,
	WagerFinancialInvariantError,
} from '../domain/errors.js';
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

export class ProcessWagerUseCase {
	constructor(private readonly unitOfWork: WageringUnitOfWork) {}

	async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
		const prepared = await prepareWager(command);
		const scope = `wagering:v1:${JSON.stringify(prepared.providerId)}`;
		return this.unitOfWork.execute(async context => {
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
			const { result, change } = await this.process(
				transaction,
				wallet,
				context,
				at,
			);
			await context.transactions.insert(transaction);
			if (change !== undefined) {
				await context.wallets.save(wallet);
				await context.ledger.append(
					WalletLedgerEntry.create({
						...change,
						id: crypto.randomUUID(),
						transactionId: transaction.id,
						createdAt: at,
					}),
				);
			}
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
		});
	}

	private async process(
		transaction: WagerTransaction,
		wallet: Wallet,
		context: WageringTransactionContext,
		at: Date,
	): Promise<{
		result: ProcessWagerResult;
		change?: BalanceChange | undefined;
	}> {
		const identity = {
			transactionId: transaction.id,
			externalTransactionId: transaction.externalTransactionId,
			walletId: wallet.id,
			idempotentReplay: false,
		};
		const reject = (
			failureCode: string,
		): { result: ProcessWagerResult } => {
			transaction.reject(failureCode);
			return { result: { ...identity, status: 'REJECTED', failureCode } };
		};
		if (transaction.kind !== 'LOSS' && transaction.money.isZero())
			return reject('ZERO_AMOUNT_NOT_ALLOWED');
		let reference: WagerReference | undefined;
		if (transaction.referenceExternalTransactionId !== undefined) {
			const found = await context.transactions.findByExternalIdentity(
				transaction.providerId,
				transaction.referenceExternalTransactionId,
			);
			if (found !== undefined)
				reference = {
					transaction: found,
					processedReversalKinds:
						await context.transactions.findProcessedReversalKinds(
							found.id,
						),
				};
		}
		let decision;
		try {
			decision = transaction.processingDecision(reference);
		} catch (error) {
			if (
				error instanceof InvalidWagerReversalError &&
				reference?.processedReversalKinds.some(
					kind => kind === transaction.kind,
				) === true
			)
				return reject('DUPLICATE_REVERSAL');
			if (
				error instanceof IncompatibleWagerReferenceError ||
				error instanceof InvalidWagerReversalError ||
				error instanceof WagerFinancialInvariantError
			)
				return reject('INCOMPATIBLE_REFERENCE');
			throw error;
		}
		switch (decision.type) {
			case 'POLICY_REQUIRED':
				return reject(
					decision.policy === 'ZERO_AMOUNT'
						? 'ZERO_AMOUNT_NOT_ALLOWED'
						: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
				);
			case 'PENDING_REFERENCE': {
				transaction.markPendingReference();
				return {
					result: {
						...identity,
						status: 'PENDING_REFERENCE',
						pendingReference: {
							reason: 'NOT_FOUND',
							externalTransactionId:
								transaction.referenceExternalTransactionId ??
								'',
						},
					},
				};
			}
			case 'REFERENCE_NOT_PROCESSED': {
				if (reference === undefined)
					throw new Error('Missing reference decision facts');
				if (
					decision.status === 'REJECTED' ||
					decision.status === 'FAILED'
				)
					return reject('REFERENCE_TERMINAL_INELIGIBLE');
				return {
					result: {
						...identity,
						status: 'PENDING',
						pendingReference: {
							reason: 'NOT_PROCESSED',
							externalTransactionId:
								reference.transaction.externalTransactionId,
							transactionId: reference.transaction.id,
							status: decision.status,
						},
					},
				};
			}
			case 'READY':
				break;
		}
		let change: BalanceChange | undefined;
		try {
			switch (decision.consequence.direction) {
				case 'DEBIT':
					change = wallet.debit(decision.consequence.money, at);
					break;
				case 'CREDIT':
					change = wallet.credit(decision.consequence.money, at);
					break;
				case 'NONE':
					break;
			}
		} catch (error) {
			if (error instanceof InsufficientBalanceError)
				return reject(
					transaction.kind === 'BET'
						? 'BET_INSUFFICIENT_BALANCE'
						: 'REVERSAL_INSUFFICIENT_BALANCE',
				);
			throw error;
		}
		transaction.markProcessed(at, reference);
		return {
			result: {
				...identity,
				status: 'PROCESSED',
				balance: wallet.balance.toProps(),
			},
			change,
		};
	}
}
