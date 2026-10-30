import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import {
	PublisherModule,
	EVENT_PUBLISHER,
	OUTBOX_STORE,
	PUBLISHER_CONFIG,
} from '../../src/bootstrap/publisher.module.js';
import type { PublisherConfig } from '../../src/platform/messaging/publisher-config.js';
import type {
	ClaimResult,
	EventPublisher,
	OutboxClaim,
	OutboxStore,
} from '../../src/platform/messaging/outbox.js';
import { OutboxPublisher } from '../../src/platform/messaging/outbox-publisher.js';
import { MikroOrmOutboxStore } from '../../src/platform/persistence/mikro-orm-outbox-store.js';
import { SqsEventPublisher } from '../../src/modules/wagering/adapters/sqs/sqs-event-publisher.js';

let mode = process.env.PUBLISHER_TEST_MODE ?? 'normal';
let release: (() => void) | undefined;
let start: (() => void) | undefined;
const runtime: { worker?: OutboxPublisher } = {};
function report(event: string, extra: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ event, pid: process.pid, ...extra }));
}
async function barrier(event: string, eventId: string): Promise<void> {
	await new Promise<void>(resolve => {
		release = resolve;
		report(event, { eventId });
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
		else if (value === 'start') start?.();
		else if (value === 'stop') {
			runtime.worker?.requestStop();
			start?.();
		} else {
			mode = value;
			report(`armed:${value}`);
		}
	}
});
const module = await Test.createTestingModule({ imports: [PublisherModule] })
	.overrideProvider(OUTBOX_STORE)
	.useFactory({
		inject: [MikroORM],
		factory: (orm: MikroORM): OutboxStore => {
			const real = new MikroOrmOutboxStore(orm.em);
			return {
				claim: async (
					limit,
					owner,
					leaseMs,
				): Promise<readonly OutboxClaim[]> => {
					const claims = await real.claim(limit, owner, leaseMs);
					if (claims.length > 0)
						report('claimed_batch', {
							ids: claims.map(claim => claim.eventId),
						});
					return claims;
				},
				published: async (claim): Promise<ClaimResult> => {
					if (mode === 'finalize-fail') {
						mode = 'normal';
						throw new Error('Injected SQL finalization failure');
					}
					return real.published(claim);
				},
				retry: (claim, wait, code) => real.retry(claim, wait, code),
				diagnostics: () => real.diagnostics(),
			};
		},
	})
	.overrideProvider(EVENT_PUBLISHER)
	.useFactory({
		inject: [PUBLISHER_CONFIG],
		factory: (config: PublisherConfig): EventPublisher => {
			const real = new SqsEventPublisher(config);
			return {
				check: (): Promise<void> => real.check(),
				close: (): void => {
					real.close();
				},
				publish: async (event, signal): Promise<void> => {
					if (mode === 'before-send') {
						mode = 'normal';
						await barrier('before-send', event.eventId);
					}
					await real.publish(event, signal);
					if (mode === 'after-send') {
						mode = 'normal';
						await barrier('after-send', event.eventId);
					}
				},
			};
		},
	})
	.compile();
await module.init();
const worker = module.get(OutboxPublisher);
runtime.worker = worker;
const sender = module.get<EventPublisher>(EVENT_PUBLISHER);
await sender.check();
try {
	await new Promise<void>(resolve => {
		start = resolve;
		report('ready');
	});
	await worker.run();
} finally {
	sender.close();
	await module.close();
	report('closed', { connected: await module.get(MikroORM).isConnected() });
	process.stdin.destroy();
}
