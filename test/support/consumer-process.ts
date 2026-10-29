import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import {
	ConsumerModule,
	SQS_CONFIG,
} from '../../src/bootstrap/consumer.module.js';
import { SQS_TRANSPORT } from '../../src/bootstrap/sqs.js';
import { createUnitOfWork } from '../../src/bootstrap/persistence.js';
import { UNIT_OF_WORK } from '../../src/modules/financial/public/index.js';
import type {
	WageringTransactionContext,
	WageringUnitOfWork,
} from '../../src/modules/wagering/public/persistence.js';
import { SqsTransport } from '../../src/platform/messaging/sqs-transport.js';
import type { SqsConfig } from '../../src/platform/messaging/sqs-config.js';
import type { MessageTransport } from '../../src/platform/messaging/transport.js';
import { ReliableConsumer } from '../../src/platform/messaging/reliable-consumer.js';

let mode = process.env.CONSUMER_TEST_MODE ?? 'normal';
let release: (() => void) | undefined;
const runtime: { consumer?: ReliableConsumer } = {};
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
		const value = buffer.slice(0, end);
		buffer = buffer.slice(end + 1);
		if (value === 'release') release?.();
		else if (value === 'stop') {
			runtime.consumer?.requestStop();
			report('stopping');
		} else {
			mode = value;
			report(`armed:${value}`);
		}
	}
});
const module = await Test.createTestingModule({ imports: [ConsumerModule] })
	.overrideProvider(UNIT_OF_WORK)
	.useFactory({
		inject: [MikroORM],
		factory: (orm: MikroORM): WageringUnitOfWork => {
			const base = createUnitOfWork(orm);
			return {
				execute: <T>(
					work: (context: WageringTransactionContext) => Promise<T>,
				): Promise<T> =>
					base.execute(async context => {
						const hold =
							mode === 'before-commit' ||
							mode === 'expire-before-commit';
						if (mode === 'before-commit') mode = 'normal';
						const value = await work(context);
						if (hold) await barrier('before-commit');
						return value;
					}),
			};
		},
	})
	.overrideProvider(SQS_TRANSPORT)
	.useFactory({
		inject: [SQS_CONFIG],
		factory: (config: SqsConfig): MessageTransport => {
			const real = new SqsTransport(config);
			return {
				receive: (max, signal) => real.receive(max, signal),
				check: () => real.check(),
				close: (): void => {
					real.close();
				},
				visibility: (message, seconds) =>
					mode === 'expire-before-commit'
						? Promise.resolve()
						: real.visibility(message, seconds),
				ack: async (message): Promise<void> => {
					if (mode === 'after-commit') {
						mode = 'normal';
						await barrier('committed-before-ack');
					}
					if (mode === 'ack-fail') {
						mode = 'normal';
						report('injected-ack-failure');
						throw new Error('injected DeleteMessage failure');
					}
					await real.ack(message);
				},
			};
		},
	})
	.compile();
await module.init();
const activeConsumer = module.get(ReliableConsumer);
runtime.consumer = activeConsumer;
const transport = module.get<MessageTransport>(SQS_TRANSPORT);
await transport.check();
const settings = await module
	.get(MikroORM)
	.em.execute<{ transaction_ms: string; statement_ms: string }[]>(
		"select (extract(epoch from current_setting('transaction_timeout')::interval) * 1000)::text as transaction_ms, (extract(epoch from current_setting('statement_timeout')::interval) * 1000)::text as statement_ms",
	);
report('ready', {
	transactionTimeoutMs: Number(settings[0]?.transaction_ms),
	statementTimeoutMs: Number(settings[0]?.statement_ms),
});
try {
	await activeConsumer.run();
} finally {
	transport.close();
	await module.close();
	report('closed', { connected: await module.get(MikroORM).isConnected() });
	process.stdin.destroy();
}
