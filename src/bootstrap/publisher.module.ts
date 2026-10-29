import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../platform/persistence/config.js';
import { MikroOrmOutboxStore } from '../platform/persistence/mikro-orm-outbox-store.js';
import { publisherConfig } from '../platform/messaging/publisher-config.js';
import type { PublisherConfig } from '../platform/messaging/publisher-config.js';
import { OutboxPublisher } from '../platform/messaging/outbox-publisher.js';
import type {
	EventPublisher,
	OutboxStore,
} from '../platform/messaging/outbox.js';
import { SqsEventPublisher } from '../modules/wagering/adapters/sqs/sqs-event-publisher.js';

export const PUBLISHER_CONFIG = Symbol('PublisherConfig');
export const OUTBOX_STORE = Symbol('OutboxStore');
export const EVENT_PUBLISHER = Symbol('EventPublisher');

@Module({
	imports: [
		MikroOrmModule.forRootAsync({
			driver: PostgreSqlDriver,
			useFactory: () => {
				const config = persistenceConfig();
				const publisher = publisherConfig();
				return {
					...config,
					driverOptions: {
						...config.driverOptions,
						statement_timeout: publisher.sqlMs,
						options: `-c transaction_timeout=${String(publisher.sqlMs)}`,
						application_name: `outbox-publisher-${String(process.pid)}`,
					},
					pool: {
						...config.pool,
						acquireTimeoutMillis: publisher.sqlMs,
					},
				};
			},
		}),
	],
	providers: [
		{ provide: PUBLISHER_CONFIG, useFactory: publisherConfig },
		{
			provide: OUTBOX_STORE,
			inject: [MikroORM],
			useFactory: (orm: MikroORM): OutboxStore =>
				new MikroOrmOutboxStore(orm.em),
		},
		{
			provide: EVENT_PUBLISHER,
			inject: [PUBLISHER_CONFIG],
			useFactory: (config: PublisherConfig): EventPublisher =>
				new SqsEventPublisher(config),
		},
		{
			provide: OutboxPublisher,
			inject: [OUTBOX_STORE, EVENT_PUBLISHER, PUBLISHER_CONFIG],
			useFactory: (
				store: OutboxStore,
				publisher: EventPublisher,
				config: PublisherConfig,
			): OutboxPublisher => new OutboxPublisher(store, publisher, config),
		},
	],
})
export class PublisherModule {}
