import { Money } from '../../financial/public/index.js';
import {
	ForbiddenWagerTransitionError,
	IncompatibleWagerReferenceError,
	InvalidWagerOperationError,
	InvalidWagerReversalError,
	InvalidWagerStateError,
	WagerDecisionRequiredError,
	WagerFinancialInvariantError,
} from './errors.js';
import type {
	FinancialConsequence,
	WagerProcessingDecision,
	WagerReversalKind,
	WagerTransactionKind,
	WagerTransactionStatus,
} from './wager-types.js';

export interface WagerInput {
	readonly providerId: string;
	readonly externalTransactionId: string;
	readonly idempotencyKey: string;
	readonly playerId: string;
	readonly roundId: string;
	readonly gameId: string;
	readonly kind: WagerTransactionKind;
	readonly money: Money;
	readonly referenceExternalTransactionId?: string | undefined;
}

export interface CreateWagerTransactionProps extends WagerInput {
	readonly id: string;
	readonly payloadHash: string;
	readonly walletId: string;
	readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
	readonly status: WagerTransactionStatus;
	readonly referenceTransactionId?: string | undefined;
	readonly failureCode?: string | undefined;
	readonly processedAt?: Date | undefined;
}

/** Reference and reversal history read under the wallet lock. */
export interface WagerReference {
	readonly transaction: WagerTransaction;
	readonly processedReversalKinds: readonly WagerReversalKind[];
	/** A processed rollback neutralized the processed refund of this BET. */
	readonly refundReversed?: boolean;
}

const kinds: readonly string[] = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
const statuses: readonly string[] = [
	'PENDING',
	'PENDING_REFERENCE',
	'PROCESSED',
	'REJECTED',
	'FAILED',
];

function isText(value: string): boolean {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		!value.includes('\0') &&
		// UTF-8 drivers replace isolated surrogates, collapsing distinct identities.
		!/[\uD800-\uDFFF]/u.test(value)
	);
}

function isUuid(value: string): boolean {
	return (
		typeof value === 'string' &&
		/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
	);
}

function isValidDate(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}

export class WagerTransaction {
	readonly id: string;
	readonly providerId: string;
	readonly externalTransactionId: string;
	readonly idempotencyKey: string;
	readonly payloadHash: string;
	readonly walletId: string;
	readonly playerId: string;
	readonly roundId: string;
	readonly gameId: string;
	readonly kind: WagerTransactionKind;
	readonly money: Money;
	readonly referenceExternalTransactionId: string | undefined;
	readonly #createdAt: number;
	#status: WagerTransactionStatus;
	#referenceTransactionId: string | undefined;
	#failureCode: string | undefined;
	#processedAt: number | undefined;

	private constructor(state: WagerTransactionState) {
		this.id = state.id.toLowerCase();
		this.walletId = state.walletId.toLowerCase();
		this.providerId = state.providerId;
		this.externalTransactionId = state.externalTransactionId;
		this.idempotencyKey = state.idempotencyKey;
		this.payloadHash = state.payloadHash;
		this.playerId = state.playerId;
		this.roundId = state.roundId;
		this.gameId = state.gameId;
		this.kind = state.kind;
		this.money = state.money;
		this.referenceExternalTransactionId =
			state.referenceExternalTransactionId;
		this.#createdAt = state.createdAt.getTime();
		this.#status = state.status;
		this.#referenceTransactionId =
			state.referenceTransactionId?.toLowerCase();
		this.#failureCode = state.failureCode;
		this.#processedAt = state.processedAt?.getTime();
		Object.freeze(this);
	}

	static create(props: CreateWagerTransactionProps): WagerTransaction {
		WagerTransaction.validateBusinessData(props);
		return new WagerTransaction({
			...props,
			status: 'PENDING',
			referenceTransactionId: undefined,
			failureCode: undefined,
			processedAt: undefined,
		});
	}

	static validateInput(props: WagerInput): void {
		if (
			![
				props.providerId,
				props.externalTransactionId,
				props.idempotencyKey,
				props.playerId,
				props.roundId,
				props.gameId,
			].every(isText) ||
			!(props.money instanceof Money) ||
			props.money.isNegative() ||
			(props.referenceExternalTransactionId !== undefined &&
				!isText(props.referenceExternalTransactionId))
		) {
			throw new InvalidWagerStateError(
				'Invalid wagering business data or malformed Unicode text',
			);
		}
		if (!kinds.includes(props.kind)) {
			throw new InvalidWagerOperationError(
				'Unsupported provider operation',
			);
		}
		if (
			(props.kind === 'REFUND' || props.kind === 'ROLLBACK') &&
			props.referenceExternalTransactionId === undefined
		) {
			throw new InvalidWagerReversalError(
				'Reversals require an external reference',
			);
		}
		if (
			props.referenceExternalTransactionId === props.externalTransactionId
		) {
			throw new IncompatibleWagerReferenceError(
				'A transaction cannot reference itself',
			);
		}
	}

	static rehydrate(state: WagerTransactionState): WagerTransaction {
		WagerTransaction.validateBusinessData(state);
		const hasReference = state.referenceExternalTransactionId !== undefined;
		const processed = state.status === 'PROCESSED';
		const unsuccessful =
			state.status === 'REJECTED' || state.status === 'FAILED';
		if (
			!statuses.includes(state.status) ||
			(state.referenceTransactionId !== undefined &&
				(!isUuid(state.referenceTransactionId) ||
					!hasReference ||
					state.referenceTransactionId.toLowerCase() ===
						state.id.toLowerCase())) ||
			(state.status === 'PENDING_REFERENCE' &&
				(!hasReference ||
					state.referenceTransactionId !== undefined)) ||
			(processed &&
				hasReference &&
				state.referenceTransactionId === undefined) ||
			processed !== (state.processedAt !== undefined) ||
			(state.processedAt !== undefined &&
				(!isValidDate(state.processedAt) ||
					state.processedAt < state.createdAt)) ||
			unsuccessful !== (state.failureCode !== undefined) ||
			(state.failureCode !== undefined && !isText(state.failureCode))
		) {
			throw new InvalidWagerStateError(
				'Inconsistent persisted wagering state',
			);
		}
		return new WagerTransaction(state);
	}

	private static validateBusinessData(
		props: CreateWagerTransactionProps,
	): void {
		WagerTransaction.validateInput(props);
		if (
			!isUuid(props.id) ||
			!isUuid(props.walletId) ||
			!isText(props.payloadHash) ||
			!isValidDate(props.createdAt)
		) {
			throw new InvalidWagerStateError('Invalid wagering business data');
		}
	}

	get currency(): string {
		return this.money.currency;
	}
	get status(): WagerTransactionStatus {
		return this.#status;
	}
	get referenceTransactionId(): string | undefined {
		return this.#referenceTransactionId;
	}
	get failureCode(): string | undefined {
		return this.#failureCode;
	}
	get createdAt(): Date {
		return new Date(this.#createdAt);
	}
	get processedAt(): Date | undefined {
		return this.#processedAt === undefined
			? undefined
			: new Date(this.#processedAt);
	}

	isTerminal(): boolean {
		return (
			this.#status === 'PROCESSED' ||
			this.#status === 'REJECTED' ||
			this.#status === 'FAILED'
		);
	}

	requiresReference(): boolean {
		return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
	}

	matchesPayload(payloadHash: string): boolean {
		return this.payloadHash === payloadHash;
	}

	processingDecision(reference?: WagerReference): WagerProcessingDecision {
		this.assertNonterminal();
		if (this.referenceExternalTransactionId !== undefined) {
			if (reference === undefined)
				return Object.freeze({ type: 'PENDING_REFERENCE' });
			this.validateReference(reference.transaction);
			if (reference.transaction.status !== 'PROCESSED') {
				return Object.freeze({
					type: 'REFERENCE_NOT_PROCESSED',
					status: reference.transaction.status,
				});
			}
			if (this.requiresReference()) {
				if (
					!Array.isArray(reference.processedReversalKinds) ||
					reference.processedReversalKinds.some(
						kind => kind !== 'REFUND' && kind !== 'ROLLBACK',
					)
				) {
					throw new InvalidWagerReversalError(
						'Complete processed reversal history is required',
					);
				}
				if (reference.processedReversalKinds.includes(this.kind)) {
					throw new InvalidWagerReversalError(
						'Reference already reversed by this operation kind',
					);
				}
				if (
					reference.processedReversalKinds.length > 0 &&
					!(
						this.kind === 'ROLLBACK' &&
						reference.transaction.kind === 'BET' &&
						reference.processedReversalKinds.includes('REFUND') &&
						reference.refundReversed === true
					)
				) {
					return Object.freeze({
						type: 'POLICY_REQUIRED',
						policy: 'CROSS_TYPE_REVERSAL',
					});
				}
			}
		} else if (reference !== undefined) {
			throw new IncompatibleWagerReferenceError(
				'No reference was requested',
			);
		}
		if (this.kind !== 'LOSS' && this.money.isZero()) {
			return Object.freeze({
				type: 'POLICY_REQUIRED',
				policy: 'ZERO_AMOUNT',
			});
		}
		const direction = this.directionFor(reference?.transaction);
		const consequence: FinancialConsequence =
			direction === 'NONE'
				? Object.freeze({ direction })
				: Object.freeze({ direction, money: this.money });
		return Object.freeze({
			type: 'READY',
			consequence,
			referenceTransactionId: reference?.transaction.id,
		});
	}

	markProcessed(at: Date, reference?: WagerReference): FinancialConsequence {
		const decision = this.processingDecision(reference);
		if (decision.type !== 'READY') {
			throw new WagerDecisionRequiredError(
				'Processing requires a ready domain decision',
			);
		}
		if (!isValidDate(at) || at.getTime() < this.#createdAt) {
			throw new InvalidWagerStateError(
				'Processing time must not precede creation',
			);
		}
		this.#referenceTransactionId = decision.referenceTransactionId;
		this.#processedAt = at.getTime();
		this.#status = 'PROCESSED';
		return decision.consequence;
	}

	markPendingReference(reference?: WagerReference): void {
		this.assertNonterminal();
		if (this.#status !== 'PENDING') {
			throw new ForbiddenWagerTransitionError(
				'Already waiting for a reference',
			);
		}
		if (this.processingDecision(reference).type !== 'PENDING_REFERENCE') {
			throw new WagerDecisionRequiredError(
				'Only a missing reference permits waiting',
			);
		}
		this.#status = 'PENDING_REFERENCE';
	}

	reject(code: string): void {
		this.recordFailure('REJECTED', code);
	}

	fail(code: string): void {
		this.recordFailure('FAILED', code);
	}

	private recordFailure(status: 'REJECTED' | 'FAILED', code: string): void {
		this.assertNonterminal();
		if (!isText(code))
			throw new InvalidWagerStateError('A failure code is required');
		this.#failureCode = code;
		this.#status = status;
	}

	private assertNonterminal(): void {
		if (this.isTerminal()) {
			throw new ForbiddenWagerTransitionError(
				'Terminal transactions cannot be processed or transitioned',
			);
		}
	}

	private validateReference(reference: WagerTransaction): void {
		if (
			!(reference instanceof WagerTransaction) ||
			reference.id === this.id ||
			reference.externalTransactionId !==
				this.referenceExternalTransactionId ||
			reference.providerId !== this.providerId ||
			reference.playerId !== this.playerId ||
			reference.walletId !== this.walletId ||
			reference.currency !== this.currency ||
			reference.roundId !== this.roundId
		) {
			throw new IncompatibleWagerReferenceError(
				'Reference identity or business context differs',
			);
		}
		if (this.kind === 'WIN' && reference.kind !== 'BET') {
			throw new IncompatibleWagerReferenceError(
				'WIN may reference only BET',
			);
		}
		if (
			(this.kind === 'REFUND' && reference.kind !== 'BET') ||
			(this.kind === 'ROLLBACK' &&
				reference.kind !== 'BET' &&
				reference.kind !== 'WIN' &&
				reference.kind !== 'REFUND')
		) {
			throw new InvalidWagerReversalError(
				'Operation cannot reverse this reference kind',
			);
		}
		if (this.requiresReference() && !this.money.equals(reference.money)) {
			throw new WagerFinancialInvariantError(
				'Only full amount reversals are supported',
			);
		}
	}

	private directionFor(
		reference: WagerTransaction | undefined,
	): FinancialConsequence['direction'] {
		switch (this.kind) {
			case 'BET':
				return 'DEBIT';
			case 'WIN':
			case 'REFUND':
				return 'CREDIT';
			case 'LOSS':
				return 'NONE';
			case 'ROLLBACK':
				return reference?.kind === 'BET' ? 'CREDIT' : 'DEBIT';
		}
	}
}
