import { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { persistenceConfig } from '../../src/platform/persistence/config.js';
import { MikroOrmPendingWagerStore } from '../../src/modules/wagering/adapters/persistence/mikro-orm-pending.repository.js';
import { ResolvePendingWagerUseCase } from '../../src/modules/wagering/application/resolve-pending-wager.use-case.js';
import type { WageringUnitOfWork } from '../../src/modules/wagering/public/persistence.js';
import type { ProcessWagerCommand } from '../../src/modules/wagering/public/process-wager.js';

const input = JSON.parse(
	process.env.WAGER_COMMAND ?? 'null',
) as ProcessWagerCommand | null;
if (input === null) throw new Error('Missing pending test input');
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
		application_name: `pending-test-${String(process.pid)}`,
	},
});
try {
	const base = createUnitOfWork(orm);
	const uow: WageringUnitOfWork = {
		execute: work =>
			base.execute(async context => {
				const result = await work(context);
				if (mode === 'hold-commit' || mode === 'crash-before-commit') {
					report('before-commit');
					await gate();
				}
				return result;
			}),
	};
	report('ready');
	await gate();
	const claims = await new MikroOrmPendingWagerStore(orm.em).claim(
		1,
		`test-${String(process.pid)}`,
		Number(process.env.PENDING_TEST_LEASE_MS ?? '30000'),
	);
	const claim = claims[0];
	if (claim === undefined) report('EMPTY');
	else {
		if (mode === 'hold-claim') {
			report('claimed');
			await gate();
		}
		const result = await new ResolvePendingWagerUseCase(
			uow,
			86400000,
		).execute(claim, 1000);
		if (mode === 'crash-after-commit') {
			report('committed-before-response');
			await gate();
		}
		report(result);
	}
} finally {
	await orm.close(true);
	process.stdin.destroy();
}
