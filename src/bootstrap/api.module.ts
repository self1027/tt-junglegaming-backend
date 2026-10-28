import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { HealthController } from '../platform/observability/health.controller.js';
import { persistenceConfig } from '../platform/persistence/config.js';

@Module({
	imports: [
		MikroOrmModule.forRootAsync({
			driver: PostgreSqlDriver,
			useFactory: () => persistenceConfig(),
		}),
	],
	controllers: [HealthController],
})
export class ApiModule {}
