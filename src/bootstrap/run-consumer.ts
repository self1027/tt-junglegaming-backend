import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { ConsumerModule, SQS_CONFIG } from './consumer.module.js';
import { SQS_TRANSPORT } from './sqs.js';
import type { SqsConfig } from '../platform/messaging/sqs-config.js';
import type { MessageTransport } from '../platform/messaging/transport.js';
import { ReliableConsumer } from '../platform/messaging/reliable-consumer.js';
import { sqsConfig } from '../platform/messaging/sqs-config.js';
import { persistenceConfig } from '../platform/persistence/config.js';

export async function runConsumer(): Promise<void> {
	sqsConfig();
	persistenceConfig();
	const app = await NestFactory.createApplicationContext(ConsumerModule, {
		logger: false,
		abortOnError: false,
	});
	const consumer = app.get(ReliableConsumer);
	const config = app.get<SqsConfig>(SQS_CONFIG);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const stop = (): void => {
		consumer.requestStop();
		if (deadline !== undefined) return;
		console.log(
			JSON.stringify({ event: 'consumer_stopping', pid: process.pid }),
		);
		deadline = setTimeout(() => {
			console.error(
				JSON.stringify({
					event: 'shutdown_deadline',
					pid: process.pid,
				}),
			);
			app.get<MessageTransport>(SQS_TRANSPORT).close();
			process.exit(1);
		}, config.shutdownMs);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	try {
		await app.get<MikroORM>(MikroORM).em.execute('select 1');
		await app.get<MessageTransport>(SQS_TRANSPORT).check();
		console.log(
			JSON.stringify({ event: 'consumer_ready', pid: process.pid }),
		);
		await consumer.run();
	} finally {
		consumer.requestStop();
		try {
			await app.close();
		} finally {
			if (deadline !== undefined) clearTimeout(deadline);
			process.off('SIGTERM', stop);
			process.off('SIGINT', stop);
		}
	}
}
