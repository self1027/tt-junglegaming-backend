import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { ApiModule } from '../../src/bootstrap/api.module.js';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { UNIT_OF_WORK } from '../../src/modules/financial/public/index.js';
import type {
	WageringTransactionContext,
	WageringUnitOfWork,
} from '../../src/modules/wagering/public/persistence.js';
import type { Wallet } from '../../src/modules/financial/public/index.js';

process.env.PGAPPNAME = `http-test-${String(process.pid)}`;

let armed: string | undefined;
let release: (() => void) | undefined;
function report(event: string, extra: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ event, pid: process.pid, ...extra }));
}
async function barrier(event: string): Promise<void> {
	await new Promise<void>(resolve => {
		release = resolve;
		report(event);
	});
	release = undefined;
}
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let end: number;
	while ((end = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, end);
		buffer = buffer.slice(end + 1);
		if (line === 'release') release?.();
		else {
			armed = line;
			report(`armed:${line}`);
		}
	}
});
const module = await Test.createTestingModule({ imports: [ApiModule] })
	.overrideProvider(UNIT_OF_WORK)
	.useFactory({
		inject: [MikroORM],
		factory: (orm: MikroORM): WageringUnitOfWork => {
			const base = createUnitOfWork(orm);
			return {
				execute: async <T>(
					work: (context: WageringTransactionContext) => Promise<T>,
					options?: { readonly readOnly: true },
				): Promise<T> => {
					const mode = armed;
					armed = undefined;
					const result = await base.execute(async context => {
						const view =
							mode === 'snapshot'
								? {
										...context,
										wallets: {
											findById: async (
												id: string,
											): Promise<Wallet | undefined> => {
												const wallet =
													await context.wallets.findById(
														id,
													);
												await barrier('snapshot-read');
												return wallet;
											},
											findByPlayerAndCurrency: (
												playerId: string,
												currency: string,
											): Promise<Wallet | undefined> =>
												context.wallets.findByPlayerAndCurrency(
													playerId,
													currency,
												),
											lockById: (
												id: string,
											): Promise<Wallet | undefined> =>
												context.wallets.lockById(id),
											insert: (
												wallet: Wallet,
											): Promise<void> =>
												context.wallets.insert(wallet),
											save: (
												wallet: Wallet,
											): Promise<void> =>
												context.wallets.save(wallet),
										},
									}
								: context;
						const value = await work(view);
						if (mode === 'commit') await barrier('before-commit');
						return value;
					}, options);
					if (mode === 'response')
						await barrier('committed-before-response');
					return result;
				},
			};
		},
	})
	.compile();
const app = module.createNestApplication();
app.useLogger(false);
await app.listen(0, '127.0.0.1');
report('ready', { url: await app.getUrl() });
let closing = false;
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	release?.();
	await app.close();
	report('closed', { connected: await app.get(MikroORM).isConnected() });
	process.stdin.destroy();
}
process.on('SIGTERM', () => {
	void close();
});
process.stdin.on('end', () => {
	void close();
});
