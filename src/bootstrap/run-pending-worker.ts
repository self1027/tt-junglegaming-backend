import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import {
	PendingWorkerModule,
	PENDING_CONFIG,
} from './pending-worker.module.js';
import { PendingReferenceWorker } from '../modules/wagering/adapters/worker/pending-reference-worker.js';
import { pendingWorkerConfig } from '../modules/wagering/adapters/worker/pending-config.js';
import type { PendingWorkerConfig } from '../modules/wagering/adapters/worker/pending-config.js';
import { persistenceConfig } from '../platform/persistence/config.js';

export async function runPendingWorker(): Promise<void> {
	pendingWorkerConfig();
	persistenceConfig();
	const app = await NestFactory.createApplicationContext(
		PendingWorkerModule,
		{ logger: false, abortOnError: false },
	);
	const worker = app.get(PendingReferenceWorker);
	const config = app.get<PendingWorkerConfig>(PENDING_CONFIG);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const stop = (): void => {
		worker.requestStop();
		if (deadline !== undefined) return;
		console.log(
			JSON.stringify({ event: 'pending_stopping', pid: process.pid }),
		);
		deadline = setTimeout(() => {
			console.error(
				JSON.stringify({
					event: 'pending_shutdown_deadline',
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
		console.log(
			JSON.stringify({
				event: 'pending_ready',
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
