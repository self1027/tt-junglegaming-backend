import { Injectable } from '@nestjs/common';
import type {
	CallHandler,
	ExecutionContext,
	NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';
import { WagerController } from '../modules/wagering/adapters/http/wager.controller.js';
import {
	diagnostic,
	diagnosticIdentity,
} from '../platform/observability/diagnostic.js';

@Injectable()
export class WagerDiagnosticsInterceptor implements NestInterceptor {
	intercept(
		context: ExecutionContext,
		next: CallHandler<unknown>,
	): Observable<unknown> {
		const request = context.switchToHttp().getRequest<{ body: unknown }>();
		if (context.getHandler() !== WagerController.prototype.submit)
			return next.handle();
		const started = Date.now();
		return next.handle().pipe(
			tap({
				next: result => {
					if (typeof result !== 'object' || result === null) return;
					const identity = {
						...diagnosticIdentity(request.body),
						...diagnosticIdentity(result),
					};
					diagnostic({
						event: 'http_wager_completed',
						...identity,
						correlationId: identity.transactionId,
						status: 'status' in result ? result.status : undefined,
						idempotentReplay:
							'idempotentReplay' in result &&
							result.idempotentReplay === true,
						latencyMs: Date.now() - started,
					});
				},
				error: () => {
					diagnostic({
						event: 'http_wager_failed',
						latencyMs: Date.now() - started,
					});
				},
			}),
		);
	}
}
