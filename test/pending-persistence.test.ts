import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import { ResolvePendingWagerUseCase } from '../src/modules/wagering/application/resolve-pending-wager.use-case.js';
import { MikroOrmPendingWagerStore } from '../src/modules/wagering/adapters/persistence/mikro-orm-pending.repository.js';
import {
	OutboxMessageRow,
	WagerTransactionRow,
	IdempotencyRecordRow,
	WalletLedgerEntryRow,
} from '../src/platform/persistence/models.js';
import { startPostgres, testOrm, command } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import {
	seedPending,
	seedNeutralizedRollback,
	pendingCommand,
	pendingClaim,
	resolvePending,
	reconciled,
} from './support/pending.js';
import { openWallet } from './support/financial.js';
import type { WageringTransactionContext } from '../src/modules/wagering/public/persistence.js';
import { pendingUntil } from './support/pending.js';
import { PendingClaimLostError } from '../src/modules/wagering/public/pending.js';

let postgres: TestPostgres;
let orm: MikroORM;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
	postgres = await startPostgres();
	cleanup.push(postgres.close);
	orm = await testOrm(postgres);
	cleanup.push(() => orm.close(true));
	await orm.migrator.up();
}, 120000);
afterEach(async () => {
	await orm.em.execute(
		"update wager_transactions set next_attempt_at = clock_timestamp() + interval '1 day', claim_token = null, claimed_by = null, claimed_until = null where status in ('PENDING', 'PENDING_REFERENCE')",
	);
});
afterAll(async () => {
	for (const close of cleanup.reverse()) await close();
}, 30000);

test('migration up/status/down/up preserves preexisting pending and terminal financial history', async () => {
	await orm.migrator.down({ to: 'Migration202610290001' });
	const w = await orm.em.execute<{ id: string; player_id: string }[]>(
		"insert into wallets (player_id, currency, balance) values (?, 'BRL', 0.00) returning id, player_id",
		[crypto.randomUUID()],
	);
	const wallet = w[0];
	if (wallet === undefined) throw new Error('Missing wallet');
	const ids: string[] = [];
	for (const status of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED']) {
		const id = crypto.randomUUID();
		ids.push(id);
		await orm.em.execute(
			`insert into wager_transactions (id, wallet_id, player_id, provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id, processed_at)
			values (?, ?, ?, 'legacy', ?, ?, 'hash', 'round', 'game', 'WIN', ?, 1.00, 'BRL', ?, ?)`,
			[
				id,
				wallet.id,
				wallet.player_id,
				id,
				id,
				status,
				status === 'PROCESSED' ? null : 'missing',
				status === 'PROCESSED' ? new Date() : null,
			],
		);
	}
	const before = await orm.em.execute(
		'select * from wager_transactions where id in (?, ?, ?) order by id',
		ids,
	);
	expect(
		await command([process.execPath, 'run', 'db:status'], postgres.env),
	).toContain('Migration202610290002');
	await command([process.execPath, 'run', 'db:migrate'], postgres.env);
	expect(await orm.migrator.getPending()).toHaveLength(0);
	await orm.migrator.down({ to: 'Migration202610290001' });
	expect(
		await orm.em.execute(
			'select * from wager_transactions where id in (?, ?, ?) order by id',
			ids,
		),
	).toEqual(before);
	await orm.migrator.up();
	expect(
		await new MikroOrmPendingWagerStore(orm.em).claim(10, 'legacy', 30000),
	).toHaveLength(2);
});

test('selection respects due order, limit, SKIP LOCKED, PENDING metadata and partial range index', async () => {
	const a = await seedPending(orm);
	const b = await seedPending(orm);
	const c = await seedPending(orm);
	await orm.em.execute(
		"update wager_transactions set next_attempt_at = clock_timestamp() + interval '1 hour' where id = ?",
		[c.id],
	);
	const em = orm.em.fork();
	await em.begin();
	try {
		await em.execute(
			'select id from wager_transactions where id = ? for update',
			[a.id],
		);
		const claims = await new MikroOrmPendingWagerStore(orm.em).claim(
			1,
			'skip-locked',
			30000,
		);
		expect(claims.map(claim => claim.transaction.id)).toEqual([b.id]);
		expect(claims[0]?.attempts).toBe(1);
		expect(
			await new MikroOrmPendingWagerStore(orm.em).claim(
				10,
				'other',
				30000,
			),
		).toEqual([]);
	} finally {
		await em.rollback();
	}
	const fresh = orm.em.fork();
	await fresh.execute('set enable_seqscan = off');
	const plan = await fresh.execute(
		`explain select id from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE') and reference_external_transaction_id is not null and kind <> 'OPENING' and coalesce(next_attempt_at, created_at) <= statement_timestamp() order by coalesce(next_attempt_at, created_at), created_at, id limit 1`,
	);
	expect(JSON.stringify(plan)).toContain('wager_pending_due_idx');
	expect(JSON.stringify(plan)).toContain('Index Cond');
	await fresh.execute('reset enable_seqscan');
});

test.each([
	['REFUND', 'BET', '100.00'],
	['ROLLBACK', 'BET', '100.00'],
	['ROLLBACK', 'WIN', '100.00'],
] as const)(
	'%s before %s resolves existing identity atomically and replay preserves terminal historical balance',
	async (kind, originalKind, balance) => {
		const f = await seedPending(orm, '100.00', kind, originalKind);
		const useCase = new ProcessWagerUseCase(createUnitOfWork(orm));
		const before = await orm.em
			.fork()
			.findOneOrFail(IdempotencyRecordRow, { transactionId: f.id });
		expect(await useCase.execute(f.pending)).toMatchObject({
			status: 'PENDING_REFERENCE',
			idempotentReplay: true,
		});
		expect(await resolvePending(orm, f.id)).toBe('WAITING');
		const scheduled = await orm.em
			.fork()
			.findOneOrFail(WagerTransactionRow, { id: f.id });
		expect(scheduled.lastError).toBe('NOT_FOUND');
		expect(scheduled.nextAttemptAt).toBeInstanceOf(Date);
		expect(scheduled.lastAttemptAt).toBeInstanceOf(Date);
		expect(scheduled.attempts).toBe(1);
		expect(
			(
				await orm.em.fork().findOneOrFail(IdempotencyRecordRow, {
					transactionId: f.id,
				})
			).originalResult,
		).toEqual(before.originalResult);
		await useCase.execute(f.original);
		expect(await resolvePending(orm, f.id)).toBe('PROCESSED');
		await reconciled(orm, f.wallet.id, balance, 3);
		const terminal = await useCase.execute(f.pending);
		expect(terminal).toMatchObject({
			transactionId: f.id,
			status: 'PROCESSED',
			idempotentReplay: true,
			balance: { amount: balance },
		});
		await useCase.execute(
			pendingCommand(f.wallet, {
				kind: 'WIN',
				amount: { amount: '1.00', currency: 'BRL' },
			}),
		);
		expect(await useCase.execute(f.pending)).toEqual(terminal);
		const after = await orm.em
			.fork()
			.findOneOrFail(IdempotencyRecordRow, { transactionId: f.id });
		expect(after.payloadHash).toBe(before.payloadHash);
		expect(after.id).toBe(before.id);
		expect(
			await orm.em.fork().count(WagerTransactionRow, {
				providerId: f.pending.providerId,
				externalTransactionId: f.pending.externalTransactionId,
			}),
		).toBe(1);
		expect(
			await orm.em
				.fork()
				.count(WalletLedgerEntryRow, { transactionId: f.id }),
		).toBe(1);
		const events = await orm.em
			.fork()
			.find(OutboxMessageRow, { correlationId: f.id });
		expect(events.map(e => e.eventType).sort()).toEqual(
			[
				'WagerTransactionPendingReference',
				'WagerTransactionProcessed',
				'WalletBalanceChanged',
			].sort(),
		);
	},
);

test('PENDING chain waits for processed REFUND, then ROLLBACK debits; known pending TTL has a distinct code', async () => {
	const f = await seedPending(orm);
	const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
	const rollback = pendingCommand(f.wallet, {
		kind: 'ROLLBACK',
		referenceExternalTransactionId: f.pending.externalTransactionId,
	});
	const r = await uc.execute(rollback);
	expect(r.status).toBe('PENDING');
	expect(await resolvePending(orm, r.transactionId)).toBe('WAITING');
	expect(
		(
			await orm.em
				.fork()
				.findOneOrFail(WagerTransactionRow, { id: r.transactionId })
		).lastError,
	).toBe('NOT_PROCESSED');
	await uc.execute(f.original);
	expect(await resolvePending(orm, f.id)).toBe('PROCESSED');
	expect(await resolvePending(orm, r.transactionId)).toBe('PROCESSED');
	await reconciled(orm, f.wallet.id, '20.00', 4);
	const g = await seedPending(orm);
	const waiting = await uc.execute(
		pendingCommand(g.wallet, {
			kind: 'ROLLBACK',
			referenceExternalTransactionId: g.pending.externalTransactionId,
		}),
	);
	await orm.em.execute(
		"update wager_transactions set created_at = created_at - interval '2 days' where id = ?",
		[waiting.transactionId],
	);
	expect(await resolvePending(orm, waiting.transactionId)).toBe('REJECTED');
	expect(
		(
			await orm.em.fork().findOneOrFail(WagerTransactionRow, {
				id: waiting.transactionId,
			})
		).failureCode,
	).toBe('REFERENCE_NOT_PROCESSED_EXHAUSTED');
});

test('TTL revalidates current reference: expired missing rejects; expired but eligible still processes', async () => {
	for (const ready of [false, true]) {
		const f = await seedPending(orm);
		const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
		await orm.em.execute(
			"update wager_transactions set created_at = created_at - interval '2 days' where id = ?",
			[f.id],
		);
		if (ready) await uc.execute(f.original);
		expect(await resolvePending(orm, f.id)).toBe(
			ready ? 'PROCESSED' : 'REJECTED',
		);
		expect(await uc.execute(f.pending)).toMatchObject(
			ready
				? { status: 'PROCESSED' }
				: {
						status: 'REJECTED',
						failureCode: 'REFERENCE_NOT_FOUND_EXHAUSTED',
					},
		);
		await reconciled(orm, f.wallet.id, '100.00', ready ? 3 : 1);
	}
});

test.each([
	'REJECTED',
	'FAILED',
	'INCOMPATIBLE',
	'INSUFFICIENT',
	'DUPLICATE',
	'CUMULATIVE',
] as const)(
	'terminal resolution %s preserves the approved failure and cannot reopen',
	async cause => {
		const reversal = cause === 'INSUFFICIENT' ? 'ROLLBACK' : 'REFUND';
		const f = await seedPending(
			orm,
			'100.00',
			reversal,
			cause === 'INSUFFICIENT' ? 'WIN' : 'BET',
		);
		const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
		if (cause === 'REJECTED') {
			await uc.execute(
				pendingCommand(f.wallet, {
					amount: { amount: '40.00', currency: 'BRL' },
				}),
			);
			await uc.execute(f.original);
		} else if (cause === 'FAILED') {
			const prepared =
				await import('../src/modules/wagering/application/canonical-wager.js');
			const domain =
				await import('../src/modules/wagering/public/index.js');
			const data = await prepared.prepareWager(f.original);
			const tx = domain.WagerTransaction.create({
				...data,
				id: crypto.randomUUID(),
				walletId: f.wallet.id,
				createdAt: new Date(),
			});
			tx.fail('PERMANENT_TEST');
			await createUnitOfWork(orm).execute(c => c.transactions.insert(tx));
		} else {
			await uc.execute(
				cause === 'INCOMPATIBLE'
					? { ...f.original, roundId: 'other-round' }
					: f.original,
			);
			if (cause === 'INSUFFICIENT')
				await uc.execute(
					pendingCommand(f.wallet, {
						amount: { amount: '150.00', currency: 'BRL' },
					}),
				);
			if (cause === 'DUPLICATE' || cause === 'CUMULATIVE')
				await uc.execute(
					pendingCommand(f.wallet, {
						kind: cause === 'DUPLICATE' ? 'REFUND' : 'ROLLBACK',
						referenceExternalTransactionId:
							f.original.externalTransactionId,
					}),
				);
		}
		expect(await resolvePending(orm, f.id)).toBe('REJECTED');
		const code = {
			REJECTED: 'REFERENCE_TERMINAL_INELIGIBLE',
			FAILED: 'REFERENCE_TERMINAL_INELIGIBLE',
			INCOMPATIBLE: 'INCOMPATIBLE_REFERENCE',
			INSUFFICIENT: 'REVERSAL_INSUFFICIENT_BALANCE',
			DUPLICATE: 'DUPLICATE_REVERSAL',
			CUMULATIVE: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
		}[cause];
		expect(await uc.execute(f.pending)).toMatchObject({
			status: 'REJECTED',
			failureCode: code,
		});
		expect(
			await orm.em
				.fork()
				.count(WalletLedgerEntryRow, { transactionId: f.id }),
		).toBe(0);
		expect(
			await orm.em
				.fork()
				.count(OutboxMessageRow, { correlationId: f.id }),
		).toBe(2);
		const tx = await createUnitOfWork(orm).execute(c =>
			c.transactions.findById(f.id),
		);
		if (tx === undefined) throw new Error('Missing terminal');
		expect(
			createUnitOfWork(orm).execute(c => c.transactions.save(tx)),
		).rejects.toThrow('Wager state conflict');
	},
);

test('precision beyond 53 bits, idempotency conditional update and terminal snapshot protection', async () => {
	const f = await seedPending(
		orm,
		'9007199254741093.01',
		'REFUND',
		'BET',
		'9007199254740993.01',
	);
	const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
	await uc.execute(f.original);
	expect(await resolvePending(orm, f.id)).toBe('PROCESSED');
	await reconciled(orm, f.wallet.id, '9007199254741093.01', 3);
	const result = await uc.execute(f.pending);
	expect(
		createUnitOfWork(orm).execute(c =>
			c.idempotency.resolvePending(
				`wagering:v1:${JSON.stringify(f.pending.providerId)}`,
				f.pending.idempotencyKey,
				'wrong',
				{ ...result, idempotentReplay: false },
			),
		),
	).rejects.toThrow('Idempotency resolution conflict');
	const wallet = await createUnitOfWork(orm).execute(c => openWallet(c));
	expect(wallet.id).not.toBe(f.wallet.id);
});

test('lease expiration/readquisition fences stale resolution and retry even with the same owner', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const a = await pendingClaim(orm, f.id);
	await orm.em.execute(
		"update wager_transactions set claimed_until = clock_timestamp() - interval '1 second' where id = ?",
		[f.id],
	);
	const b = await pendingClaim(orm, f.id);
	expect(b.token).not.toBe(a.token);
	expect(b.attempts).toBe(2);
	const resolver = new ResolvePendingWagerUseCase(
		createUnitOfWork(orm),
		86400000,
	);
	expect(await resolver.execute(a, 1000)).toBe('CLAIM_LOST');
	await new MikroOrmPendingWagerStore(orm.em).retry(a, 1000);
	expect(
		(await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: f.id }))
			.claimToken,
	).toBe(b.token);
	expect(await resolver.execute(b, 1000)).toBe('PROCESSED');
	expect(await resolver.execute(b, 1000)).toBe('CLAIM_LOST');
	await reconciled(orm, f.wallet.id, '100.00', 3);
});

test('lease expiring after wallet/ledger/idempotency/Outbox writes rolls every effect back at final fencing', async () => {
	const f = await seedPending(orm);
	await new ProcessWagerUseCase(createUnitOfWork(orm)).execute(f.original);
	const claim = await pendingClaim(orm, f.id, 1000);
	const base = createUnitOfWork(orm);
	const resolver = new ResolvePendingWagerUseCase(
		{
			execute: <T>(
				work: (context: WageringTransactionContext) => Promise<T>,
			): Promise<T> =>
				base.execute(c => {
					if (c.pending === undefined)
						throw new Error('Missing resolution repository');
					const repository = c.pending;
					return work({
						...c,
						pending: {
							lock: (token, ttl) => repository.lock(token, ttl),
							finish: async (
								token,
								tx,
								delayMs,
								reason,
							): Promise<void> => {
								await pendingUntil(
									async () =>
										(
											await orm.em.execute(
												'select id from wager_transactions where id = ? and claimed_until <= clock_timestamp()',
												[f.id],
											)
										).length === 1,
									'lease expires during financial work',
								);
								await repository.finish(
									token,
									tx,
									delayMs,
									reason,
								);
							},
						},
					});
				}),
		},
		86400000,
	);
	expect(resolver.execute(claim, 1000)).rejects.toBeInstanceOf(
		PendingClaimLostError,
	);
	await reconciled(orm, f.wallet.id, '20.00', 2);
	expect(
		await orm.em
			.fork()
			.count(WalletLedgerEntryRow, { transactionId: f.id }),
	).toBe(0);
	expect(
		await orm.em.fork().count(OutboxMessageRow, { correlationId: f.id }),
	).toBe(1);
	expect(
		(
			await orm.em
				.fork()
				.findOneOrFail(IdempotencyRecordRow, { transactionId: f.id })
		).originalResult,
	).toMatchObject({ status: 'PENDING_REFERENCE' });
	expect(await resolvePending(orm, f.id)).toBe('PROCESSED');
	await reconciled(orm, f.wallet.id, '100.00', 3);
});

test.each(['WIN', 'LOSS'] as const)(
	'optional reference on %s uses the same worker; LOSS emits no balance change',
	async kind => {
		const uow = createUnitOfWork(orm);
		const uc = new ProcessWagerUseCase(uow);
		const wallet = await uow.execute(c => openWallet(c));
		const original = pendingCommand(wallet);
		const dependent = pendingCommand(wallet, {
			kind,
			referenceExternalTransactionId: original.externalTransactionId,
		});
		const result = await uc.execute(dependent);
		expect(result.status).toBe('PENDING_REFERENCE');
		await uc.execute(original);
		expect(await resolvePending(orm, result.transactionId)).toBe(
			'PROCESSED',
		);
		await reconciled(
			orm,
			wallet.id,
			kind === 'LOSS' ? '20.00' : '100.00',
			kind === 'LOSS' ? 2 : 3,
		);
		expect(
			await orm.em.fork().count(OutboxMessageRow, {
				correlationId: result.transactionId,
			}),
		).toBe(kind === 'LOSS' ? 2 : 3);
	},
);

test.each(
	([false, true] as const).flatMap(neutralized =>
		(
			[
				'wallet',
				'ledger',
				'wager',
				'idempotency',
				'outbox-first',
				'outbox-second',
				'after-finish',
			] as const
		).map(fault => ({ fault, neutralized })),
	),
)(
	'PostgreSQL rollback is complete at $fault, neutralized refund=$neutralized',
	async ({ fault, neutralized }) => {
		const f = neutralized
			? await seedNeutralizedRollback(orm)
			: await seedPending(orm);
		const uc = new ProcessWagerUseCase(createUnitOfWork(orm));
		if (!neutralized) await uc.execute(f.original);
		const claim = await pendingClaim(orm, f.id);
		const before = await orm.em
			.fork()
			.findOneOrFail(IdempotencyRecordRow, { transactionId: f.id });
		const target = {
			wallet: {
				table: 'wallets',
				event: 'update',
				match: `new.id = '${f.wallet.id}'::uuid`,
			},
			ledger: {
				table: 'wallet_ledger_entries',
				event: 'insert',
				match: `new.transaction_id = '${f.id}'::uuid`,
			},
			wager: {
				table: 'wager_transactions',
				event: 'update',
				match: `new.id = '${f.id}'::uuid and new.status = 'PROCESSED'`,
			},
			idempotency: {
				table: 'idempotency_records',
				event: 'update',
				match: `new.transaction_id = '${f.id}'::uuid`,
			},
			'outbox-first': {
				table: 'outbox_messages',
				event: 'insert',
				match: `new.correlation_id = '${f.id}' and new.event_type = 'WagerTransactionProcessed'`,
			},
			'outbox-second': {
				table: 'outbox_messages',
				event: 'insert',
				match: `new.correlation_id = '${f.id}' and new.event_type = 'WalletBalanceChanged'`,
			},
			'after-finish': {
				table: 'wager_transactions',
				event: 'update',
				match: 'false',
			},
		}[fault];
		await orm.em.execute(
			`create function pending_fault() returns trigger language plpgsql as $$ begin if ${target.match} then raise exception 'injected resolution failure' using errcode = '23514'; end if; return new; end $$`,
		);
		await orm.em.execute(
			`create trigger pending_fault before ${target.event} on ${target.table} for each row execute function pending_fault()`,
		);
		try {
			const base = createUnitOfWork(orm);
			const resolver = new ResolvePendingWagerUseCase(
				{
					execute: <T>(
						work: (
							context: WageringTransactionContext,
						) => Promise<T>,
					): Promise<T> =>
						base.execute(async c => {
							const result = await work(c);
							if (fault === 'after-finish')
								await orm.em.fork().execute('select 1 / 0');
							return result;
						}),
				},
				86400000,
			);
			expect(resolver.execute(claim, 1000)).rejects.toMatchObject({
				code: fault === 'after-finish' ? '22012' : '23514',
			});
		} finally {
			await orm.em.execute(
				`drop trigger pending_fault on ${target.table}`,
			);
			await orm.em.execute('drop function pending_fault()');
		}
		await reconciled(orm, f.wallet.id, '20.00', neutralized ? 4 : 2);
		expect(
			await orm.em
				.fork()
				.count(WalletLedgerEntryRow, { transactionId: f.id }),
		).toBe(0);
		expect(
			await orm.em
				.fork()
				.findOneOrFail(IdempotencyRecordRow, { transactionId: f.id }),
		).toMatchObject({
			originalResult: before.originalResult,
			payloadHash: before.payloadHash,
		});
		const row = await orm.em
			.fork()
			.findOneOrFail(WagerTransactionRow, { id: f.id });
		expect(row.status).toBe('PENDING_REFERENCE');
		expect(row.claimToken).toBe(claim.token);
		expect(
			await orm.em
				.fork()
				.count(OutboxMessageRow, { correlationId: f.id }),
		).toBe(1);
		expect(
			await new ResolvePendingWagerUseCase(
				createUnitOfWork(orm),
				86400000,
			).execute(claim, 1000),
		).toBe('PROCESSED');
		await reconciled(orm, f.wallet.id, '100.00', neutralized ? 5 : 3);
	},
);
