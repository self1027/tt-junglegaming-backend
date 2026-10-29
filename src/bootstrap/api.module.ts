import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../modules/financial/public/index.js';
import { createUnitOfWork } from './persistence.js';
import { HealthController } from '../platform/observability/health.controller.js';
import { persistenceConfig } from '../platform/persistence/config.js';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { WalletController } from '../modules/financial/adapters/http/wallet.controller.js';
import { WagerController } from '../modules/wagering/adapters/http/wager.controller.js';
import { CreateWalletUseCase } from '../modules/financial/application/create-wallet.use-case.js';
import { QueryWalletUseCase } from '../modules/financial/application/query-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../modules/financial/application/reconcile-wallet.use-case.js';
import { QueryWagerUseCase } from '../modules/wagering/application/query-wager.use-case.js';
import { ProcessWagerUseCase } from '../modules/wagering/application/process-wager.use-case.js';
import type { WageringUnitOfWork } from '../modules/wagering/public/persistence.js';
import { HttpErrorFilter } from './http-error.filter.js';
import { WalletReconciliationDiagnostics } from './reconciliation-diagnostics.js';
import { READINESS } from '../platform/observability/readiness.js';
import { createReadiness } from './readiness.js';
import { NoAuthGuard } from './no-auth.guard.js';
import { SQS_TRANSPORT, optionalSqsTransport } from './sqs.js';

@Module({
	imports: [
		MikroOrmModule.forRootAsync({
			driver: PostgreSqlDriver,
			useFactory: () => persistenceConfig(),
		}),
	],
	controllers: [HealthController, WalletController, WagerController],
	providers: [
		{ provide: APP_GUARD, useClass: NoAuthGuard },
		{ provide: SQS_TRANSPORT, useFactory: optionalSqsTransport },
		{
			provide: READINESS,
			inject: [MikroORM, SQS_TRANSPORT],
			useFactory: createReadiness,
		},
		{ provide: APP_FILTER, useClass: HttpErrorFilter },
		WalletReconciliationDiagnostics,
		{
			provide: CreateWalletUseCase,
			inject: [UNIT_OF_WORK],
			useFactory: (uow: WageringUnitOfWork): CreateWalletUseCase =>
				new CreateWalletUseCase(uow),
		},
		{
			provide: QueryWalletUseCase,
			inject: [UNIT_OF_WORK],
			useFactory: (uow: WageringUnitOfWork): QueryWalletUseCase =>
				new QueryWalletUseCase(uow),
		},
		{
			provide: ReconcileWalletUseCase,
			inject: [UNIT_OF_WORK, WalletReconciliationDiagnostics],
			useFactory: (
				uow: WageringUnitOfWork,
				diagnostics: WalletReconciliationDiagnostics,
			): ReconcileWalletUseCase =>
				new ReconcileWalletUseCase(uow, diagnostics),
		},
		{
			provide: QueryWagerUseCase,
			inject: [UNIT_OF_WORK],
			useFactory: (uow: WageringUnitOfWork): QueryWagerUseCase =>
				new QueryWagerUseCase(uow),
		},
		{
			provide: ProcessWagerUseCase,
			inject: [UNIT_OF_WORK],
			useFactory: (uow: WageringUnitOfWork): ProcessWagerUseCase =>
				new ProcessWagerUseCase(uow),
		},
		{
			provide: UNIT_OF_WORK,
			inject: [MikroORM],
			useFactory: createUnitOfWork,
		},
	],
	exports: [UNIT_OF_WORK],
})
export class ApiModule {}
