import {
	InsufficientBalanceError,
	WalletLedgerEntry,
} from '../../financial/public/index.js';
import type { BalanceChange, Wallet } from '../../financial/public/index.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { WagerReference } from '../domain/wager-transaction.js';
import {
	IncompatibleWagerReferenceError,
	InvalidWagerReversalError,
	WagerFinancialInvariantError,
} from '../domain/errors.js';
import type { WageringTransactionContext } from '../public/persistence.js';
import type { ProcessWagerResult } from '../public/process-wager.js';
export async function processWager(
	transaction: WagerTransaction,
	wallet: Wallet,
	context: WageringTransactionContext,
	at: Date,
	referenceExpired = false,
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
	const reject = (failureCode: string): { result: ProcessWagerResult } => {
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
		if (found !== undefined) {
			const processedReversalKinds =
				await context.transactions.findProcessedReversalKinds(found.id);
			reference = {
				transaction: found,
				processedReversalKinds,
				refundReversed:
					transaction.kind === 'ROLLBACK' &&
					found.kind === 'BET' &&
					processedReversalKinds.includes('REFUND') &&
					(await context.transactions.hasReversedRefund(found.id)),
			};
		}
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
			if (referenceExpired)
				return reject('REFERENCE_NOT_FOUND_EXHAUSTED');
			if (transaction.status === 'PENDING')
				transaction.markPendingReference();
			return {
				result: {
					...identity,
					status: 'PENDING_REFERENCE',
					pendingReference: {
						reason: 'NOT_FOUND',
						externalTransactionId:
							transaction.referenceExternalTransactionId ?? '',
					},
				},
			};
		}
		case 'REFERENCE_NOT_PROCESSED': {
			if (reference === undefined)
				throw new Error('Missing reference decision facts');
			if (decision.status === 'REJECTED' || decision.status === 'FAILED')
				return reject('REFERENCE_TERMINAL_INELIGIBLE');
			if (referenceExpired)
				return reject('REFERENCE_NOT_PROCESSED_EXHAUSTED');
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

export async function saveWagerBalanceChange(
	transaction: WagerTransaction,
	wallet: Wallet,
	context: WageringTransactionContext,
	change: BalanceChange | undefined,
	at: Date,
): Promise<void> {
	if (change === undefined) return;
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
