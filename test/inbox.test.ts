import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../src/modules/wagering/application/process-wager.use-case.js';
import type { WageringUnitOfWork } from '../src/modules/wagering/public/persistence.js';
import { InboxPayloadConflict } from '../src/modules/wagering/public/inbox.js';
import { parseWagerMessage } from '../src/modules/wagering/adapters/sqs/wager-message.js';
import { CreateWalletUseCase } from '../src/modules/financial/application/create-wallet.use-case.js';
import { startPostgres, testOrm } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';

let postgres: TestPostgres;
let orm: MikroORM;
let uow: WageringUnitOfWork;
beforeAll(async () => {
	postgres = await startPostgres();
	orm = await testOrm(postgres);
	await orm.migrator.up();
	uow = createUnitOfWork(orm);
}, 90000);
afterAll(async () => {
	try {
		if (typeof orm !== 'undefined') await orm.close(true);
	} finally {
		if (typeof postgres !== 'undefined') await postgres.close();
	}
}, 30000);

async function message(): Promise<
	Awaited<ReturnType<typeof parseWagerMessage>>
> {
	const playerId = crypto.randomUUID();
	const wallet = await new CreateWalletUseCase(uow).execute({
		playerId,
		initialBalance: { amount: '100.00', currency: 'BRL' },
	});
	return parseWagerMessage(
		JSON.stringify({
			messageId: crypto.randomUUID(),
			type: 'WagerTransactionRequested',
			occurredAt: '2026-10-29T12:00:00.000Z',
			data: {
				providerId: 'provider',
				externalTransactionId: crypto.randomUUID(),
				idempotencyKey: crypto.randomUUID(),
				walletId: wallet.id,
				playerId,
				roundId: 'round',
				gameId: 'game',
				kind: 'BET',
				money: { amount: '10.00', currency: 'BRL' },
			},
		}),
	);
}

test('Inbox commit contains financial effects and concurrent duplicate claims only apply once', async () => {
	const input = await message();
	const useCase = new ProcessWagerUseCase(uow);
	const results = await Promise.all(
		Array.from({ length: 10 }, () =>
			useCase.execute(input.command, input.delivery),
		),
	);
	expect(results.filter(result => result !== undefined)).toHaveLength(1);
	const rows = await orm.em.execute<{ status: string; attempts: number }[]>(
		'select status, attempts from inbox_messages where message_id = ?',
		[input.delivery.messageId],
	);
	expect(rows).toEqual([{ status: 'PROCESSED', attempts: 10 }]);
	const balance = await uow.execute(context =>
		context.wallets.findById(input.command.walletId ?? ''),
	);
	expect(balance?.balance.toProps().amount).toBe('90.00');
	expect(
		await useCase.execute(input.command, input.delivery),
	).toBeUndefined();
	const conflict = await useCase
		.execute(input.command, { ...input.delivery, payloadHash: 'different' })
		.catch((error: unknown): unknown => error);
	expect(conflict).toBeInstanceOf(InboxPayloadConflict);
	const events = await orm.em.execute<{ count: string }[]>(
		'select count(*) from outbox_messages where aggregate_id = ?',
		[input.command.walletId],
	);
	expect(events[0]?.count).toBe('1');
});

test('failure completing Inbox rolls back Inbox, wallet, ledger, Wagering, idempotency and Outbox', async () => {
	const input = await message();
	const faulty: WageringUnitOfWork = {
		execute: work =>
			uow.execute(context =>
				work({
					...context,
					inbox: {
						claim: delivery => {
							if (context.inbox === undefined)
								throw new Error('Missing Inbox');
							return context.inbox.claim(delivery);
						},
						complete: async () => {
							await orm.em.execute('select 1');
							throw new Error('inbox completion fault');
						},
					},
				}),
			),
	};
	const failure = await new ProcessWagerUseCase(faulty)
		.execute(input.command, input.delivery)
		.catch((error: unknown): unknown => error);
	expect(failure).toBeInstanceOf(Error);
	expect(failure instanceof Error ? failure.message : '').toBe(
		'inbox completion fault',
	);
	expect(
		await orm.em.execute(
			'select * from inbox_messages where message_id = ?',
			[input.delivery.messageId],
		),
	).toHaveLength(0);
	expect(
		await orm.em.execute(
			'select * from wager_transactions where external_transaction_id = ?',
			[input.command.externalTransactionId],
		),
	).toHaveLength(0);
	expect(
		await orm.em.execute(
			'select * from idempotency_records where idempotency_key = ?',
			[input.command.idempotencyKey],
		),
	).toHaveLength(0);
	expect(
		await orm.em.execute(
			'select * from outbox_messages where aggregate_id = ?',
			[input.command.walletId],
		),
	).toHaveLength(0);
	const wallet = await uow.execute(context =>
		context.wallets.findById(input.command.walletId ?? ''),
	);
	expect(wallet?.balance.toProps().amount).toBe('100.00');
	const ledger = await uow.execute(context =>
		context.ledger.findByWalletId(input.command.walletId ?? ''),
	);
	expect(ledger).toHaveLength(1);
	expect(
		(
			await new ProcessWagerUseCase(uow).execute(
				input.command,
				input.delivery,
			)
		)?.status,
	).toBe('PROCESSED');
});
