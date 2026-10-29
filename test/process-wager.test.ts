import { expect, test } from 'bun:test';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import { prepareWager } from '../src/modules/wagering/application/canonical-wager.js';
import { Wallet } from '../src/modules/financial/public/index.js';
import type { WalletLedgerEntry } from '../src/modules/financial/public/index.js';
import { WagerTransaction } from '../src/modules/wagering/public/index.js';
import { WagerApplicationError } from '../src/modules/wagering/public/process-wager.js';
import type {
	ProcessWagerCommand,
	ProcessWagerResult,
} from '../src/modules/wagering/public/process-wager.js';
import type {
	WageringTransactionContext,
	WageringUnitOfWork,
	IdempotencyClaim,
} from '../src/modules/wagering/public/persistence.js';
import { createdAt, money } from './support/financial.js';
import type { WagerIntegrationEvent } from '../src/modules/wagering/public/events.js';

function fixture(): {
	useCase: ProcessWagerUseCase;
	wallet: Wallet;
	transactions: Map<string, WagerTransaction>;
	entries: WalletLedgerEntry[];
	events: WagerIntegrationEvent[];
	results: Map<string, { hash: string; result?: ProcessWagerResult }>;
	stats: {
		executions: number;
		saves: number;
		fault: Error | undefined;
		missingWallet: boolean;
		outboxFault: Error | undefined;
	};
} {
	const wallet = Wallet.open({
		id: crypto.randomUUID(),
		playerId: 'player',
		currency: 'BRL',
		createdAt,
		initialBalance: money('100.00'),
	});
	const transactions = new Map<string, WagerTransaction>();
	const entries: WalletLedgerEntry[] = [];
	const events: WagerIntegrationEvent[] = [];
	const results = new Map<
		string,
		{ hash: string; result?: ProcessWagerResult }
	>();
	const stats = {
		executions: 0,
		saves: 0,
		fault: undefined as Error | undefined,
		missingWallet: false,
		outboxFault: undefined as Error | undefined,
	};
	const context: WageringTransactionContext = {
		outbox: {
			append: batch => {
				if (stats.outboxFault !== undefined)
					return Promise.reject(stats.outboxFault);
				events.push(...batch);
				return Promise.resolve();
			},
		},
		wallets: {
			findById: () => Promise.resolve(wallet),
			findByPlayerAndCurrency: () =>
				Promise.resolve(stats.missingWallet ? undefined : wallet),
			lockById: () => Promise.resolve(wallet),
			insert: () => Promise.resolve(),
			save: () => {
				stats.saves++;
				return Promise.resolve();
			},
		},
		ledger: {
			append: entry => {
				if (stats.fault !== undefined)
					return Promise.reject(stats.fault);
				entries.push(entry);
				return Promise.resolve();
			},
			findByWalletId: () => Promise.resolve(entries),
		},
		openings: { insert: () => Promise.resolve() },
		transactions: {
			insertProcessed: () =>
				Promise.reject(new Error('Use entity persistence')),
			lockExternalIdentity: () => Promise.resolve(),
			findById: id => Promise.resolve(transactions.get(id)),
			findByExternalIdentity: (provider, external) =>
				Promise.resolve(
					[...transactions.values()].find(
						t =>
							t.providerId === provider &&
							t.externalTransactionId === external,
					),
				),
			insert: transaction => {
				transactions.set(transaction.id, transaction);
				return Promise.resolve();
			},
			save: () => Promise.resolve(),
			findProcessedReversalKinds: id =>
				Promise.resolve(
					[...transactions.values()]
						.filter(
							t =>
								t.referenceTransactionId === id &&
								t.status === 'PROCESSED',
						)
						.flatMap(t =>
							t.kind === 'REFUND' || t.kind === 'ROLLBACK'
								? [t.kind]
								: [],
						),
				),
		},
		idempotency: {
			claim: (scope, key, hash) => {
				const identity = JSON.stringify([scope, key]);
				const record = results.get(identity);
				if (record !== undefined)
					return Promise.resolve<IdempotencyClaim>({
						type: 'EXISTING',
						payloadHash: record.hash,
						result: record.result,
					});
				results.set(identity, { hash });
				return Promise.resolve<IdempotencyClaim>({ type: 'CLAIMED' });
			},
			complete: (scope, key, hash, result) => {
				results.set(JSON.stringify([scope, key]), { hash, result });
				return Promise.resolve();
			},
		},
	};
	const uow: WageringUnitOfWork = {
		execute: work => {
			stats.executions++;
			return work(context);
		},
	};
	return {
		useCase: new ProcessWagerUseCase(uow),
		wallet,
		transactions,
		entries,
		events,
		results,
		stats,
	};
}

function command(
	overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
	const id = crypto.randomUUID();
	return {
		providerId: 'provider',
		externalTransactionId: id,
		idempotencyKey: id,
		playerId: 'player',
		roundId: 'round',
		gameId: 'game',
		kind: 'BET',
		amount: { amount: '10.00', currency: 'BRL' },
		...overrides,
	};
}

test('checks supplied wallet identity on first processing and historical replay', async () => {
	const f = fixture();
	const input = command({ walletId: crypto.randomUUID() });
	expect(f.useCase.execute(input)).rejects.toThrow('WALLET_NOT_FOUND');
	const valid = command({ walletId: f.wallet.id });
	await f.useCase.execute(valid);
	expect(
		f.useCase.execute({ ...valid, walletId: crypto.randomUUID() }),
	).rejects.toThrow('WALLET_NOT_FOUND');
	expect((await f.useCase.execute(valid)).idempotentReplay).toBe(true);
	expect(f.entries).toHaveLength(1);
});

test.each([
	['BET', '90.00', 'DEBIT'],
	['WIN', '110.00', 'CREDIT'],
	['LOSS', '100.00', 'NONE'],
] as const)(
	'%s applies its exact consequence once',
	async (kind, balance, direction) => {
		const f = fixture();
		const result = await f.useCase.execute(command({ kind }));
		expect(result).toMatchObject({
			status: 'PROCESSED',
			balance: { amount: balance, currency: 'BRL' },
			idempotentReplay: false,
		});
		expect(f.wallet.balance.toProps().amount).toBe(balance);
		expect(f.wallet.version).toBe(direction === 'NONE' ? 1 : 2);
		expect(f.entries).toHaveLength(direction === 'NONE' ? 0 : 1);
		if (direction !== 'NONE')
			expect(f.entries[0]?.direction).toBe(direction);
		expect(f.stats.saves).toBe(direction === 'NONE' ? 0 : 1);
		expect(f.stats.executions).toBe(1);
		expect(f.events.map(e => e.eventType)).toEqual(
			direction === 'NONE'
				? ['WagerTransactionProcessed']
				: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
		);
		expect(f.events[0]?.toJSON()).toMatchObject({
			aggregateId: result.transactionId,
			correlationId: result.transactionId,
			version: 1,
			data: {
				kind,
				status: 'PROCESSED',
				money: { amount: '10.00', currency: 'BRL' },
			},
		});
	},
);

test.each(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const)(
	'zero %s follows policy without ledger or wallet version',
	async kind => {
		const f = fixture();
		const result = await f.useCase.execute(
			command({
				kind,
				amount: { amount: '0.00', currency: 'BRL' },
				...(kind === 'REFUND' || kind === 'ROLLBACK'
					? { referenceExternalTransactionId: 'missing' }
					: {}),
			}),
		);
		expect(result.status).toBe(kind === 'LOSS' ? 'PROCESSED' : 'REJECTED');
		if (result.status === 'REJECTED')
			expect(result.failureCode).toBe('ZERO_AMOUNT_NOT_ALLOWED');
		expect(f.entries).toHaveLength(0);
		expect(f.wallet.version).toBe(1);
		expect(f.stats.saves).toBe(0);
	},
);

test.each([
	['BET', 'REFUND', '100.00'],
	['BET', 'ROLLBACK', '100.00'],
	['WIN', 'ROLLBACK', '100.00'],
] as const)(
	'%s followed by %s restores balance',
	async (kind, reversal, balance) => {
		const f = fixture();
		const original = command({ kind });
		await f.useCase.execute(original);
		const result = await f.useCase.execute(
			command({
				kind: reversal,
				referenceExternalTransactionId: original.externalTransactionId,
			}),
		);
		expect(result).toMatchObject({
			status: 'PROCESSED',
			balance: { amount: balance },
		});
		expect(f.entries).toHaveLength(2);
		expect(f.wallet.version).toBe(3);
		expect(f.events.map(e => e.eventType)).toEqual([
			'WagerTransactionProcessed',
			'WalletBalanceChanged',
			'WagerTransactionProcessed',
			'WalletBalanceChanged',
		]);
	},
);

test('ROLLBACK of REFUND debits once, cumulative direct reversal and repeated modality are rejected', async () => {
	const f = fixture();
	const bet = command();
	await f.useCase.execute(bet);
	const refund = command({
		kind: 'REFUND',
		referenceExternalTransactionId: bet.externalTransactionId,
	});
	await f.useCase.execute(refund);
	expect(
		await f.useCase.execute(
			command({
				kind: 'ROLLBACK',
				referenceExternalTransactionId: refund.externalTransactionId,
			}),
		),
	).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });
	expect(
		await f.useCase.execute(
			command({
				kind: 'REFUND',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
		),
	).toMatchObject({ status: 'REJECTED', failureCode: 'DUPLICATE_REVERSAL' });
	expect(
		await f.useCase.execute(
			command({
				kind: 'ROLLBACK',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
	});
	expect(f.entries).toHaveLength(3);
	expect(f.wallet.version).toBe(4);
});

test('BET insufficient funds and insufficient reversal use distinct stable codes', async () => {
	const f = fixture();
	expect(
		await f.useCase.execute(
			command({ amount: { amount: '101.00', currency: 'BRL' } }),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'BET_INSUFFICIENT_BALANCE',
	});
	const win = command({ kind: 'WIN' });
	await f.useCase.execute(win);
	await f.useCase.execute(
		command({ amount: { amount: '110.00', currency: 'BRL' } }),
	);
	expect(
		await f.useCase.execute(
			command({
				kind: 'ROLLBACK',
				referenceExternalTransactionId: win.externalTransactionId,
			}),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'REVERSAL_INSUFFICIENT_BALANCE',
	});
	expect(f.entries).toHaveLength(2);
	expect(f.wallet.version).toBe(3);
	expect(f.wallet.balance.toProps().amount).toBe('0.00');
});

test('missing reference persists and replay remains pending without effects', async () => {
	const f = fixture();
	const input = command({
		kind: 'REFUND',
		referenceExternalTransactionId: 'missing',
	});
	expect(await f.useCase.execute(input)).toMatchObject({
		status: 'PENDING_REFERENCE',
		pendingReference: {
			reason: 'NOT_FOUND',
			externalTransactionId: 'missing',
		},
	});
	expect(await f.useCase.execute(input)).toMatchObject({
		status: 'PENDING_REFERENCE',
		idempotentReplay: true,
	});
	expect(f.entries).toHaveLength(0);
	expect(f.wallet.version).toBe(1);
	expect(f.events.map(e => e.eventType)).toEqual([
		'WagerTransactionPendingReference',
	]);
});

test.each(['PENDING', 'PENDING_REFERENCE', 'REJECTED', 'FAILED'] as const)(
	'reference %s is distinguished without effects',
	async status => {
		const f = fixture();
		const reference = WagerTransaction.rehydrate({
			id: crypto.randomUUID(),
			...command({ externalTransactionId: 'reference', kind: 'BET' }),
			walletId: f.wallet.id,
			money: money('10.00'),
			payloadHash: 'hash',
			createdAt,
			status,
			referenceExternalTransactionId:
				status === 'PENDING_REFERENCE' ? 'older' : undefined,
			...(status === 'REJECTED' || status === 'FAILED'
				? { failureCode: 'TEST' }
				: {}),
		});
		f.transactions.set(reference.id, reference);
		const result = await f.useCase.execute(
			command({
				kind: 'REFUND',
				referenceExternalTransactionId: 'reference',
			}),
		);
		if (status === 'REJECTED' || status === 'FAILED')
			expect(result).toMatchObject({
				status: 'REJECTED',
				failureCode: 'REFERENCE_TERMINAL_INELIGIBLE',
			});
		else
			expect(result).toMatchObject({
				status: 'PENDING',
				pendingReference: {
					reason: 'NOT_PROCESSED',
					status,
					transactionId: reference.id,
				},
			});
		expect(f.entries).toHaveLength(0);
		expect(f.wallet.version).toBe(1);
		expect(f.events.map(e => e.eventType)).toEqual(
			status === 'REJECTED' || status === 'FAILED'
				? ['WagerTransactionRejected']
				: [],
		);
	},
);

test('incompatible reference rejects without additional financial effects', async () => {
	const f = fixture();
	const original = command({ roundId: 'another-round' });
	await f.useCase.execute(original);
	expect(
		await f.useCase.execute(
			command({
				kind: 'REFUND',
				referenceExternalTransactionId: original.externalTransactionId,
			}),
		),
	).toMatchObject({
		status: 'REJECTED',
		failureCode: 'INCOMPATIBLE_REFERENCE',
	});
	expect(f.entries).toHaveLength(1);
	expect(f.wallet.version).toBe(2);
});

test('replay preserves historical balance, conflicting key and different key external identity are application errors', async () => {
	const f = fixture();
	const input = command();
	const result = await f.useCase.execute(input);
	await f.useCase.execute(command({ kind: 'WIN' }));
	expect(await f.useCase.execute(input)).toEqual({
		...result,
		idempotentReplay: true,
	});
	expect(f.wallet.balance.toProps().amount).toBe('100.00');
	expect(f.useCase.execute({ ...input, kind: 'WIN' })).rejects.toMatchObject({
		code: 'IDEMPOTENCY_CONFLICT',
	});
	expect(
		f.useCase.execute({ ...input, idempotencyKey: 'new-key' }),
	).rejects.toMatchObject({
		code: 'EXTERNAL_TRANSACTION_CONFLICT',
		transactionId: result.transactionId,
		samePayload: true,
	});
	expect(f.entries).toHaveLength(2);
	expect(f.transactions.size).toBe(2);
	expect(f.events).toHaveLength(4);
});

test('Outbox failure propagates to UnitOfWork without a confirmed response', () => {
	const f = fixture();
	const failure = new Error('outbox unavailable');
	f.stats.outboxFault = failure;
	expect(f.useCase.execute(command())).rejects.toBe(failure);
	expect(f.events).toHaveLength(0);
	expect(
		[...f.results.values()].every(record => record.result === undefined),
	).toBe(true);
});

test('rejected replay keeps one rejection event with the original failure code', async () => {
	const f = fixture();
	const rejected = command({ amount: { amount: '101.00', currency: 'BRL' } });
	await f.useCase.execute(rejected);
	await f.useCase.execute(rejected);
	expect(f.events).toHaveLength(1);
	expect(f.events[0]?.toJSON()).toMatchObject({
		eventType: 'WagerTransactionRejected',
		data: { failureCode: 'BET_INSUFFICIENT_BALANCE', status: 'REJECTED' },
	});
});

test('technical failures propagate the original cause instead of persisting FAILED', () => {
	const f = fixture();
	const failure = new Error('temporary database failure');
	f.stats.fault = failure;
	expect(f.useCase.execute(command())).rejects.toBe(failure);
	expect([...f.transactions.values()].some(t => t.status === 'FAILED')).toBe(
		false,
	);
});

test('missing wallet is an application error', () => {
	const f = fixture();
	f.stats.missingWallet = true;
	expect(f.useCase.execute(command())).rejects.toBeInstanceOf(
		WagerApplicationError,
	);
	expect(f.transactions.size).toBe(0);
});

test('canonical payload normalizes money/null, excludes key, and snapshots inputs before awaiting hash', async () => {
	const amount = { amount: '00010.00', currency: 'BRL' };
	const input = command({ amount, referenceExternalTransactionId: null });
	const first = prepareWager(input);
	amount.amount = '99.00';
	const prepared = await first;
	const equivalent = await prepareWager({
		...input,
		amount: { amount: '10.00', currency: 'BRL' },
		idempotencyKey: 'other',
		referenceExternalTransactionId: undefined,
	});
	expect(prepared.payloadHash).toBe(equivalent.payloadHash);
	expect(prepared.money.toProps().amount).toBe('10.00');
	expect(prepared.payloadHash).toMatch(/^[a-f0-9]{64}$/);
});

test.each([
	'providerId',
	'externalTransactionId',
	'idempotencyKey',
	'playerId',
	'roundId',
	'gameId',
	'referenceExternalTransactionId',
] as const)(
	'rejects malformed Unicode in %s before SQL can collapse identities',
	field => {
		expect(prepareWager(command({ [field]: '\ud800' }))).rejects.toThrow(
			'Unicode',
		);
	},
);

test('valid Unicode pairs and replacement characters retain their exact identities', async () => {
	const prepared = await prepareWager(
		command({ playerId: 'jogador 🦧 �', providerId: 'provedor:á' }),
	);
	expect(prepared.playerId).toBe('jogador 🦧 �');
	expect(prepared.providerId).toBe('provedor:á');
});

test('canonical hash matches the documented UTF-8 SHA-256 vector', async () => {
	const prepared = await prepareWager(
		command({ externalTransactionId: 'external' }),
	);
	expect(prepared.payloadHash).toBe(
		'35699b68766e8b33676fe8bf6f0e5090f87d72a89e7383364450ef7767f67bb3',
	);
});

test('committed IN_PROGRESS is reported distinctly from a persisted pending operation', async () => {
	const f = fixture();
	const input = command();
	const prepared = await prepareWager(input);
	f.results.set(
		JSON.stringify([
			`wagering:v1:${JSON.stringify(input.providerId)}`,
			input.idempotencyKey,
		]),
		{ hash: prepared.payloadHash },
	);
	expect(f.useCase.execute(input)).rejects.toMatchObject({
		code: 'IDEMPOTENCY_IN_PROGRESS',
	});
	expect(f.entries).toHaveLength(0);
	expect(f.transactions.size).toBe(0);
	expect(f.wallet.version).toBe(1);
});
