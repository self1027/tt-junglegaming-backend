import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../modules/financial/public/index.js';
import { createUnitOfWork } from './persistence.js';
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
	providers: [
		{
			provide: UNIT_OF_WORK,
			inject: [MikroORM],
			useFactory: createUnitOfWork,
		},
	],
	exports: [UNIT_OF_WORK],
})
export class ApiModule {}
