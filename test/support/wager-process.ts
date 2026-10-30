import { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { ProcessWagerUseCase } from '../../src/modules/wagering/application/process-wager.use-case.js';
import { WagerApplicationError } from '../../src/modules/wagering/public/process-wager.js';
import type { ProcessWagerCommand } from '../../src/modules/wagering/public/process-wager.js';
import type { WageringUnitOfWork } from '../../src/modules/wagering/public/persistence.js';
import { persistenceConfig } from '../../src/platform/persistence/config.js';

const raw: unknown = JSON.parse(process.env.WAGER_COMMAND ?? 'null');
if (raw === null) throw new Error('Missing test command');
const input = raw as ProcessWagerCommand;
const mode = process.argv[2] ?? 'normal';
let permits = 0;
let resume: (() => void) | undefined;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	permits += chunk.split('\n').length - 1;
	resume?.();
});
async function gate(): Promise<void> {
	while (permits === 0)
		await new Promise<void>(resolve => {
			resume = resolve;
		});
	resume = undefined;
	permits--;
}
function report(result: string): void {
	console.log(JSON.stringify({ pid: process.pid, result }));
}
const config = persistenceConfig();
const orm = await MikroORM.init({
	...config,
	pool: { min: 0, max: 2 },
	driverOptions: {
		...config.driverOptions,
		application_name: `wager-test-${String(process.pid)}`,
	},
});
const base = createUnitOfWork(orm);
const failure = new Error('injected rollback');
let batchHeld = false;
const uow: WageringUnitOfWork = {
	execute: work =>
		base.execute(async context => {
			const result = await work(context);
			if (
				mode === 'hold-commit' ||
				mode === 'hold-rollback' ||
				mode === 'crash-before-commit' ||
				(mode === 'batch-17-hold' && !batchHeld)
			) {
				batchHeld = true;
				report('before-commit');
				await gate();
				if (mode === 'hold-rollback') throw failure;
			}
			return result;
		}),
};
try {
	report('ready');
	await gate();
	if (mode === 'read-outbox') {
		const rows = await orm.em.execute<
			{
				event_id: string;
				event_type: string;
				event_version: number;
				status: string;
			}[]
		>(
			`select event_id, event_type, event_version, status from outbox_messages where correlation_id =
			 (select id::text from wager_transactions where provider_id = ? and external_transaction_id = ?)
			 order by event_type`,
			[input.providerId, input.externalTransactionId],
		);
		report(`OUTBOX:${JSON.stringify(rows)}`);
		const replay = await new ProcessWagerUseCase(base).execute(input);
		report(replay.idempotentReplay ? 'REPLAY' : replay.status);
	} else {
		const count = mode.startsWith('batch-')
			? Number(mode.split('-')[1])
			: 1;
		if (![1, 16, 17].includes(count))
			throw new Error('Invalid test batch size');
		const results = await Promise.all(
			Array.from({ length: count }, () =>
				new ProcessWagerUseCase(uow).execute(input),
			),
		);
		const result = results[0];
		if (result === undefined) throw new Error('Missing test result');
		if (mode === 'crash-after-commit') {
			report('committed-before-response');
			await gate();
		}
		if (count > 1)
			report(
				`BATCH:${String(results.filter(r => !r.idempotentReplay).length)}:${String(results.filter(r => r.idempotentReplay).length)}`,
			);
		else report(result.idempotentReplay ? 'REPLAY' : result.status);
	}
} catch (error) {
	if (error === failure) report('rolled-back');
	else if (error instanceof WagerApplicationError) report(error.code);
	else if (
		mode === 'sql-fault' &&
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string'
	)
		report(`SQL:${error.code}`);
	else throw error;
} finally {
	await orm.close(true);
	process.stdin.destroy();
}
