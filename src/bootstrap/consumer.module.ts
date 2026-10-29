import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../modules/financial/public/index.js';
import type { WageringUnitOfWork } from '../modules/wagering/public/persistence.js';
import { ProcessWagerUseCase } from '../modules/wagering/application/process-wager.use-case.js';
import { wagerHandler } from '../modules/wagering/adapters/sqs/wager-handler.js';
import { persistenceConfig } from '../platform/persistence/config.js';
import { sqsConfig } from '../platform/messaging/sqs-config.js';
import type { SqsConfig } from '../platform/messaging/sqs-config.js';
import { SqsTransport } from '../platform/messaging/sqs-transport.js';
import { ReliableConsumer } from '../platform/messaging/reliable-consumer.js';
import { createUnitOfWork } from './persistence.js';
import { SQS_TRANSPORT } from './sqs.js';

export const SQS_CONFIG = Symbol('SqsConfig');

@Module({
	imports: [
		MikroOrmModule.forRootAsync({
			driver: PostgreSqlDriver,
			useFactory: () => {
				const config = persistenceConfig();
				const sqs = sqsConfig();
				return {
					...config,
					driverOptions: {
						...config.driverOptions,
						statement_timeout: sqs.processingMs,
						options: `-c transaction_timeout=${String(sqs.processingMs)}`,
						application_name: `wager-consumer-${String(process.pid)}`,
					},
				};
			},
		}),
	],
	providers: [
		{ provide: SQS_CONFIG, useFactory: sqsConfig },
		{
			provide: SQS_TRANSPORT,
			inject: [SQS_CONFIG],
			useFactory: (config: SqsConfig): SqsTransport =>
				new SqsTransport(config),
		},
		{
			provide: UNIT_OF_WORK,
			inject: [MikroORM],
			useFactory: createUnitOfWork,
		},
		{
			provide: ProcessWagerUseCase,
			inject: [UNIT_OF_WORK],
			useFactory: (uow: WageringUnitOfWork): ProcessWagerUseCase =>
				new ProcessWagerUseCase(uow),
		},
		{
			provide: ReliableConsumer,
			inject: [SQS_TRANSPORT, SQS_CONFIG, ProcessWagerUseCase],
			useFactory: (
				transport: SqsTransport,
				config: SqsConfig,
				useCase: ProcessWagerUseCase,
			): ReliableConsumer =>
				new ReliableConsumer(transport, config, wagerHandler(useCase)),
		},
	],
})
export class ConsumerModule {}
