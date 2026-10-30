import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../platform/persistence/config.js';
import { MikroOrmPendingWagerStore } from '../modules/wagering/adapters/persistence/mikro-orm-pending.repository.js';
import { pendingWorkerConfig } from '../modules/wagering/adapters/worker/pending-config.js';
import type { PendingWorkerConfig } from '../modules/wagering/adapters/worker/pending-config.js';
import { PendingReferenceWorker } from '../modules/wagering/adapters/worker/pending-reference-worker.js';
import { ResolvePendingWagerUseCase } from '../modules/wagering/application/resolve-pending-wager.use-case.js';
import { createUnitOfWork } from './persistence.js';

export const PENDING_CONFIG = Symbol('PendingWorkerConfig');

@Module({
	imports: [
		MikroOrmModule.forRootAsync({
			driver: PostgreSqlDriver,
			useFactory: () => {
				const config = persistenceConfig();
				const pending = pendingWorkerConfig();
				return {
					...config,
					driverOptions: {
						...config.driverOptions,
						statement_timeout: pending.sqlMs,
						options: `-c transaction_timeout=${String(pending.sqlMs + 1000)}`,
						application_name: `pending-worker-${String(process.pid)}`,
					},
					pool: {
						...config.pool,
						acquireTimeoutMillis: pending.sqlMs,
					},
				};
			},
		}),
	],
	providers: [
		{ provide: PENDING_CONFIG, useFactory: pendingWorkerConfig },
		{
			provide: PendingReferenceWorker,
			inject: [MikroORM, PENDING_CONFIG],
			useFactory: (
				orm: MikroORM,
				config: PendingWorkerConfig,
			): PendingReferenceWorker =>
				new PendingReferenceWorker(
					new MikroOrmPendingWagerStore(orm.em),
					new ResolvePendingWagerUseCase(
						createUnitOfWork(orm),
						config.ttlMs,
					),
					config,
				),
		},
	],
})
export class PendingWorkerModule {}
