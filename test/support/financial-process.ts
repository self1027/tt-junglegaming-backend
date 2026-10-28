import { MikroORM } from '@mikro-orm/postgresql';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { InsufficientBalanceError } from '../../src/modules/financial/public/index.js';
import { persistenceConfig } from '../../src/platform/persistence/config.js';
import { appendChange, changedAt, money } from './financial.js';

const walletId = process.argv[2];
const mode = process.argv[3];
if (walletId === undefined || mode === undefined)
	throw new Error('walletId and mode are required');

// Newline gates remain buffered even when the parent signals before a waiter is installed.
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
	permits -= 1;
}
function report(result: string): void {
	console.log(JSON.stringify({ pid: process.pid, result }));
}

const config = persistenceConfig();
const orm = await MikroORM.init({
	...config,
	driverOptions: {
		...config.driverOptions,
		application_name: `financial-test-${String(process.pid)}`,
		...(mode === 'timeout' ? { options: '-c lock_timeout=200ms' } : {}),
	},
});
const rollback = new Error('requested rollback');
try {
	await createUnitOfWork(orm).execute(async context => {
		report('ready');
		await gate();
		const wallet = await context.wallets.lockById(walletId);
		if (wallet === undefined) throw new Error('Missing wallet');
		report('locked');
		const change =
			mode === 'debit'
				? wallet.debit(money('80.00'), changedAt)
				: wallet.credit(money('0.01'), changedAt);
		if (change === undefined) throw new Error('Expected balance change');
		await context.wallets.save(wallet);
		await appendChange(context, wallet, change);
		if (mode.startsWith('hold-')) await gate();
		if (mode === 'hold-rollback') throw rollback;
	});
	report('committed');
} catch (error) {
	if (error === rollback) report('rolled-back');
	else if (error instanceof InsufficientBalanceError) report('insufficient');
	else if (
		error instanceof Error &&
		'code' in error &&
		error.code === '55P03'
	)
		report('55P03');
	else throw error;
} finally {
	await orm.close(true);
	process.stdin.destroy();
}
