import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import type { ProcessWagerCommand } from '../src/modules/wagering/public/process-wager.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';
import { openWallet } from './support/financial.js';
import { pendingCommand, reconciled } from './support/pending.js';

let postgres: TestPostgres;
let orm: MikroORM;
let uc: ProcessWagerUseCase;
beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await orm.migrator.up();
	uc = new ProcessWagerUseCase(createUnitOfWork(orm));
}, 90000);
afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		if (typeof postgres !== 'undefined') await postgres.close();
	}
}, 30000);

async function check(
	input: ProcessWagerCommand,
	balance: string,
	version: number,
	failureCode?: string,
): Promise<void> {
	const result = await uc.execute(input);
	expect(result).toMatchObject(
		failureCode === undefined
			? {
					status: 'PROCESSED',
					balance: { amount: balance, currency: 'BRL' },
					idempotentReplay: false,
				}
			: { status: 'REJECTED', failureCode, idempotentReplay: false },
	);
	await reconciled(orm, result.walletId, balance, version);
	expect(
		await orm.em.execute(
			'select status, failure_code from wager_transactions where id = ?',
			[result.transactionId],
		),
	).toEqual([{ status: result.status, failure_code: failureCode ?? null }]);
	const entries = await orm.em.execute(
		'select amount from wallet_ledger_entries where transaction_id = ?',
		[result.transactionId],
	);
	expect(entries).toEqual(
		failureCode === undefined ? [{ amount: input.amount.amount }] : [],
	);
	expect(
		await orm.em.execute(
			'select id from wallet_ledger_entries where wallet_id = ?',
			[result.walletId],
		),
	).toHaveLength(version);
	const events = await orm.em.execute<{ event_type: string }[]>(
		'select event_type from outbox_messages where correlation_id = ? order by event_type',
		[result.transactionId],
	);
	expect(events.map(event => event.event_type)).toEqual(
		failureCode === undefined
			? ['WagerTransactionProcessed', 'WalletBalanceChanged']
			: ['WagerTransactionRejected'],
	);
	expect(
		await orm.em.execute(
			'select original_result from idempotency_records where transaction_id = ?',
			[result.transactionId],
		),
	).toEqual([{ original_result: result }]);
}

test.each(['REFUND', 'ROLLBACK'] as const)(
	'RE-03 rejects an active compensation after %s in either arrival order',
	async first => {
		const wallet = await createUnitOfWork(orm).execute(context =>
			openWallet(context),
		);
		const bet = pendingCommand(wallet);
		await check(bet, '20.00', 2);
		await check(
			pendingCommand(wallet, {
				kind: first,
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
			'100.00',
			3,
		);
		await check(
			pendingCommand(wallet, {
				kind: first === 'REFUND' ? 'ROLLBACK' : 'REFUND',
				referenceExternalTransactionId: bet.externalTransactionId,
			}),
			'100.00',
			3,
			'CUMULATIVE_REVERSAL_NOT_ALLOWED',
		);
	},
);

test.each([
	{ opening: '100.00', stake: '80.00', debited: '20.00', later: '99.00' },
	{
		opening: '9007199254741093.01',
		stake: '9007199254740993.01',
		debited: '100.00',
		later: '9007199254741092.01',
	},
])(
	'RE-03 neutralization preserves exact money, history, events and replay for $stake',
	async values => {
		const wallet = await createUnitOfWork(orm).execute(context =>
			openWallet(context, values.opening),
		);
		const command = (
			kind: 'BET' | 'REFUND' | 'ROLLBACK',
			reference?: ProcessWagerCommand,
		): ProcessWagerCommand =>
			pendingCommand(wallet, {
				kind,
				amount: { amount: values.stake, currency: 'BRL' },
				...(reference === undefined
					? {}
					: {
							referenceExternalTransactionId:
								reference.externalTransactionId,
						}),
			});
		const bet = command('BET');
		const refund = command('REFUND', bet);
		const early = command('ROLLBACK', bet);
		await check(bet, values.debited, 2);
		await check(refund, values.opening, 3);
		await check(
			early,
			values.opening,
			3,
			'CUMULATIVE_REVERSAL_NOT_ALLOWED',
		);
		await check(command('ROLLBACK', refund), values.debited, 4);
		expect(await uc.execute(early)).toMatchObject({
			status: 'REJECTED',
			failureCode: 'CUMULATIVE_REVERSAL_NOT_ALLOWED',
			idempotentReplay: true,
		});
		const direct = command('ROLLBACK', bet);
		await check(direct, values.opening, 5);
		for (const kind of ['REFUND', 'ROLLBACK'] as const)
			await check(
				command(kind, bet),
				values.opening,
				5,
				'DUPLICATE_REVERSAL',
			);
		await check(
			pendingCommand(wallet, {
				amount: { amount: '1.00', currency: 'BRL' },
			}),
			values.later,
			6,
		);
		const before = await orm.em.execute(
			"select * from outbox_messages where payload->'data'->>'walletId' = ? order by event_id",
			[wallet.id],
		);
		for (const input of [refund, direct])
			expect(await uc.execute(input)).toMatchObject({
				status: 'PROCESSED',
				balance: { amount: values.opening },
				idempotentReplay: true,
			});
		expect(
			await orm.em.execute(
				"select * from outbox_messages where payload->'data'->>'walletId' = ? order by event_id",
				[wallet.id],
			),
		).toEqual(before);
		await reconciled(orm, wallet.id, values.later, 6);
	},
);

test('a rejected rollback of REFUND never neutralizes its compensation', async () => {
	const wallet = await createUnitOfWork(orm).execute(context =>
		openWallet(context),
	);
	const bet = pendingCommand(wallet);
	const refund = pendingCommand(wallet, {
		kind: 'REFUND',
		referenceExternalTransactionId: bet.externalTransactionId,
	});
	await check(bet, '20.00', 2);
	await check(refund, '100.00', 3);
	await check(
		pendingCommand(wallet, {
			amount: { amount: '100.00', currency: 'BRL' },
		}),
		'0.00',
		4,
	);
	await check(
		pendingCommand(wallet, {
			kind: 'ROLLBACK',
			referenceExternalTransactionId: refund.externalTransactionId,
		}),
		'0.00',
		4,
		'REVERSAL_INSUFFICIENT_BALANCE',
	);
	await check(
		pendingCommand(wallet, {
			kind: 'ROLLBACK',
			referenceExternalTransactionId: bet.externalTransactionId,
		}),
		'0.00',
		4,
		'CUMULATIVE_REVERSAL_NOT_ALLOWED',
	);
});
