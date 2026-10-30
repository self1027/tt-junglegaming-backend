import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { diagnostic } from '../platform/observability/diagnostic.js';
import { FinancialApplicationError } from '../modules/financial/public/wallet-api.js';
import { WagerApplicationError } from '../modules/wagering/public/index.js';
import {
	isPostgresPoolTimeout,
	postgresError,
} from '../platform/persistence/postgres-error.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
	catch(error: unknown, host: ArgumentsHost): void {
		let status = 500;
		let code = 'INTERNAL_ERROR';
		if (error instanceof HttpException) {
			status = error.getStatus();
			code =
				status === 404
					? 'NOT_FOUND'
					: status === 400
						? 'INVALID_REQUEST'
						: 'HTTP_ERROR';
		} else if (
			error instanceof FinancialApplicationError ||
			error instanceof WagerApplicationError
		) {
			code = error.code;
			switch (error.code) {
				case 'WALLET_NOT_FOUND':
				case 'TRANSACTION_NOT_FOUND':
					status = 404;
					break;
				case 'WALLET_ALREADY_EXISTS':
				case 'IDEMPOTENCY_CONFLICT':
				case 'EXTERNAL_TRANSACTION_CONFLICT':
					status = 409;
					break;
				case 'IDEMPOTENCY_IN_PROGRESS':
					status = 503;
					break;
				case 'INVALID_WALLET_INPUT':
				case 'INVALID_CURSOR':
					status = 400;
					break;
			}
		} else {
			const failure = postgresError(error);
			const sql = failure.code;
			if (
				isPostgresPoolTimeout(error) ||
				(sql !== undefined &&
					(sql.startsWith('08') ||
						[
							'57P01',
							'57P02',
							'57P03',
							'57014',
							'25P03',
							'25P04',
							'53300',
							'53400',
							'55P03',
							'40P01',
							'40001',
							'ECONNREFUSED',
							'ECONNRESET',
							'ETIMEDOUT',
							'EPIPE',
							'ENOTFOUND',
						].includes(sql)))
			) {
				status = 503;
				code = 'SERVICE_UNAVAILABLE';
			}
			if (
				sql === '23505' &&
				failure.constraint === 'wallets_player_currency_unique'
			) {
				status = 409;
				code = 'WALLET_ALREADY_EXISTS';
			}
		}
		diagnostic({
			event: 'http_failure',
			correlationId: crypto.randomUUID(),
			statusCode: status,
			code,
		});
		host.switchToHttp()
			.getResponse<{
				status(code: number): { json(body: unknown): void };
			}>()
			.status(status)
			.json({ statusCode: status, code });
	}
}
