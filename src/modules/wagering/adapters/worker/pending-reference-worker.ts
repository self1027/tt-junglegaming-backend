import { setTimeout as delay } from 'node:timers/promises';
import type { ResolvePendingWagerUseCase } from '../../application/resolve-pending-wager.use-case.js';
import { PendingClaimLostError } from '../../public/pending.js';
import type { PendingWagerStore } from '../../public/pending.js';
import { pendingBackoff } from './pending-config.js';
import type { PendingWorkerConfig } from './pending-config.js';
import { diagnostic } from '../../../../platform/observability/diagnostic.js';

export class PendingReferenceWorker {
	private readonly stop = new AbortController();
	constructor(
		private readonly store: PendingWagerStore,
		private readonly resolver: Pick<ResolvePendingWagerUseCase, 'execute'>,
		private readonly config: PendingWorkerConfig,
	) {}

	requestStop(): void {
		this.stop.abort();
	}

	async run(): Promise<void> {
		while (!this.stop.signal.aborted) {
			try {
				const claims = await this.store.claim(
					this.config.batchSize,
					this.config.instanceId,
					this.config.leaseMs,
				);
				await Promise.all(
					claims.map(async claim => {
						if (this.stop.signal.aborted) return;
						const started = Date.now();
						const delayMs = pendingBackoff(
							claim.attempts,
							this.config,
						);
						let outcome: string;
						try {
							outcome = await this.resolver.execute(
								claim,
								delayMs,
							);
						} catch (error) {
							outcome =
								error instanceof PendingClaimLostError
									? 'CLAIM_LOST'
									: 'SQL_UNCERTAIN';
							if (outcome === 'SQL_UNCERTAIN') {
								try {
									await this.store.retry(claim, delayMs);
								} catch {
									outcome = 'RETRY_UNCERTAIN';
								}
							}
						}
						diagnostic({
							event: 'pending_attempt',
							instanceId: this.config.instanceId,
							pid: process.pid,
							transactionId: claim.transaction.id,
							correlationId: claim.transaction.id,
							latencyMs: Date.now() - started,
							walletId: claim.transaction.walletId,
							providerId: claim.transaction.providerId,
							attempts: claim.attempts,
							outcome,
						});
					}),
				);
			} catch {
				console.error(
					JSON.stringify({
						event: 'pending_poll_failed',
						pid: process.pid,
						code: 'SQL_UNCERTAIN',
					}),
				);
			}
			try {
				await delay(this.config.pollMs, undefined, {
					signal: this.stop.signal,
				});
			} catch (error) {
				if (!(error instanceof Error) || error.name !== 'AbortError')
					throw error;
			}
		}
	}
}
