import {
	Body,
	Controller,
	Get,
	HttpCode,
	Inject,
	Param,
	Post,
	Query,
} from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case.js';
import { QueryWalletUseCase } from '../../application/query-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case.js';
import type {
	CreateWalletCommand,
	WalletReconciliationResult,
	WalletResult,
} from '../../public/wallet-api.js';
import { LedgerQueryPipe, UuidPipe } from '../../../../platform/http/input.js';
import { CreateWalletPipe } from './wallet-input.js';

@Controller('wallets')
export class WalletController {
	constructor(
		@Inject(CreateWalletUseCase)
		private readonly create: CreateWalletUseCase,
		@Inject(QueryWalletUseCase) private readonly query: QueryWalletUseCase,
		@Inject(ReconcileWalletUseCase)
		private readonly reconcile: ReconcileWalletUseCase,
	) {}

	@Post()
	open(
		@Body(CreateWalletPipe) command: CreateWalletCommand,
	): Promise<WalletResult> {
		return this.create.execute(command);
	}

	@Get(':walletId')
	find(@Param('walletId', UuidPipe) walletId: string): Promise<WalletResult> {
		return this.query.execute(walletId);
	}

	@Get(':walletId/ledger')
	ledger(
		@Param('walletId', UuidPipe) walletId: string,
		@Query(LedgerQueryPipe)
		page: { cursor?: string | undefined; limit: number },
	): Promise<{
		items: readonly Record<string, unknown>[];
		nextCursor: string | null;
	}> {
		return this.query.ledger(walletId, page);
	}

	@Post(':walletId/reconciliation')
	@HttpCode(200)
	reconciliation(
		@Param('walletId', UuidPipe) walletId: string,
	): Promise<WalletReconciliationResult> {
		return this.reconcile.execute(walletId);
	}
}
