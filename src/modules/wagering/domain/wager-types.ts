import type { Money } from '../../financial/public/index.js';

export type WagerTransactionKind =
	'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerReversalKind = 'REFUND' | 'ROLLBACK';
export type WagerTransactionStatus =
	'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export type FinancialConsequence =
	| { readonly direction: 'DEBIT' | 'CREDIT'; readonly money: Money }
	| { readonly direction: 'NONE' };

export type WagerProcessingDecision =
	| {
			readonly type: 'READY';
			readonly consequence: FinancialConsequence;
			readonly referenceTransactionId: string | undefined;
	  }
	| { readonly type: 'PENDING_REFERENCE' }
	| {
			readonly type: 'REFERENCE_NOT_PROCESSED';
			readonly status: Exclude<WagerTransactionStatus, 'PROCESSED'>;
	  }
	| {
			readonly type: 'POLICY_REQUIRED';
			readonly policy: 'ZERO_AMOUNT' | 'CROSS_TYPE_REVERSAL';
	  };
