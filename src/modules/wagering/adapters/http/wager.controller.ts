import {
	Body,
	Controller,
	Get,
	Inject,
	Param,
	Post,
	Res,
} from '@nestjs/common';
import {
	IdentityPipe,
	IdempotencyKey,
	UuidPipe,
} from '../../../../platform/http/input.js';
import { ProcessWagerUseCase } from '../../application/process-wager.use-case.js';
import { QueryWagerUseCase } from '../../application/query-wager.use-case.js';
import type {
	ProcessWagerCommand,
	ProcessWagerResult,
} from '../../public/process-wager.js';
import { WagerBodyPipe, wagerResponse } from './wager-input.js';

@Controller()
export class WagerController {
	constructor(
		@Inject(ProcessWagerUseCase)
		private readonly process: ProcessWagerUseCase,
		@Inject(QueryWagerUseCase) private readonly query: QueryWagerUseCase,
	) {}

	@Post('wagering/transactions')
	async submit(
		@Body(WagerBodyPipe) body: Omit<ProcessWagerCommand, 'idempotencyKey'>,
		@IdempotencyKey() key: string,
		@Res({ passthrough: true }) response: { status(code: number): unknown },
	): Promise<ProcessWagerResult> {
		return wagerResponse(
			await this.process.execute({ ...body, idempotencyKey: key }),
			response,
		);
	}

	@Get('wagering/transactions/:transactionId')
	find(
		@Param('transactionId', UuidPipe) transactionId: string,
	): Promise<Record<string, unknown>> {
		return this.query.execute({ transactionId });
	}

	@Get('providers/:providerId/wagering/transactions/:externalTransactionId')
	findExternal(
		@Param('providerId', IdentityPipe) providerId: string,
		@Param('externalTransactionId', IdentityPipe)
		externalTransactionId: string,
	): Promise<Record<string, unknown>> {
		return this.query.execute({ providerId, externalTransactionId });
	}
}
