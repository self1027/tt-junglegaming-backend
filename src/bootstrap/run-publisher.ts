import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import {
	PublisherModule,
	EVENT_PUBLISHER,
	PUBLISHER_CONFIG,
} from './publisher.module.js';
import { publisherConfig } from '../platform/messaging/publisher-config.js';
import type { PublisherConfig } from '../platform/messaging/publisher-config.js';
import { persistenceConfig } from '../platform/persistence/config.js';
import { OutboxPublisher } from '../platform/messaging/outbox-publisher.js';
import type { EventPublisher } from '../platform/messaging/outbox.js';

export async function runPublisher(): Promise<void> {
	publisherConfig();
	persistenceConfig();
	const app = await NestFactory.createApplicationContext(PublisherModule, {
		logger: false,
		abortOnError: false,
	});
	const worker = app.get(OutboxPublisher);
	const publisher = app.get<EventPublisher>(EVENT_PUBLISHER);
	const config = app.get<PublisherConfig>(PUBLISHER_CONFIG);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const stop = (): void => {
		worker.requestStop();
		if (deadline !== undefined) return;
		console.log(
			JSON.stringify({ event: 'publisher_stopping', pid: process.pid }),
		);
		deadline = setTimeout(() => {
			worker.abortInFlight();
			publisher.close();
			console.error(
				JSON.stringify({
					event: 'publisher_shutdown_deadline',
					pid: process.pid,
				}),
			);
			process.exit(1);
		}, config.shutdownMs);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	try {
		await app.get<MikroORM>(MikroORM).em.execute('select 1');
		await publisher.check();
		console.log(
			JSON.stringify({
				event: 'publisher_ready',
				pid: process.pid,
				instanceId: config.instanceId,
			}),
		);
		await worker.run();
	} finally {
		worker.requestStop();
		try {
			await app.close();
		} finally {
			if (deadline !== undefined) clearTimeout(deadline);
			process.off('SIGTERM', stop);
			process.off('SIGINT', stop);
		}
	}
}
