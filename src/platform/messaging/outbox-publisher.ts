import { setTimeout as delay } from 'node:timers/promises';
import { InvalidOutboxEvent } from './outbox.js';
import type { EventPublisher, OutboxClaim, OutboxStore } from './outbox.js';
import type { PublisherConfig } from './publisher-config.js';
import { diagnostic, diagnosticIdentity } from '../observability/diagnostic.js';

export function publicationFailure(error: unknown): {
	code: string;
	permanent: boolean;
} {
	if (error instanceof InvalidOutboxEvent)
		return { code: 'INVALID_EVENT', permanent: true };
	const name = error instanceof Error ? error.name : '';
	if (
		[
			'QueueDoesNotExist',
			'AWS.SimpleQueueService.NonExistentQueue',
		].includes(name)
	)
		return { code: 'QUEUE_MISSING', permanent: true };
	if (
		[
			'AccessDenied',
			'AccessDeniedException',
			'InvalidSecurity',
			'CredentialsProviderError',
		].includes(name)
	)
		return { code: 'ACCESS_DENIED', permanent: true };
	if (
		[
			'InvalidMessageContents',
			'InvalidParameterValue',
			'InvalidAddress',
			'UnsupportedOperation',
		].includes(name)
	)
		return { code: 'INVALID_REQUEST', permanent: true };
	if (['ThrottlingException', 'RequestThrottled'].includes(name))
		return { code: 'THROTTLED', permanent: false };
	return { code: 'SEND_UNCERTAIN', permanent: false };
}

export function retryDelay(
	attempt: number,
	min: number,
	max: number,
	random = Math.random(),
): number {
	const cap = Math.min(
		max,
		min * 2 ** Math.min(Math.max(0, attempt - 1), 32),
	);
	return Math.floor(min + Math.max(0, Math.min(1, random)) * (cap - min));
}

export class OutboxPublisher {
	private stopping = false;
	private readonly polling = new AbortController();
	private readonly sending = new AbortController();
	private lastError: string | null = null;
	private publishedCount = 0;
	private retryCount = 0;

	constructor(
		private readonly store: OutboxStore,
		private readonly publisher: EventPublisher,
		private readonly config: PublisherConfig,
		private readonly diagnose: (
			record: Record<string, unknown>,
		) => void = diagnostic,
	) {}

	requestStop(): void {
		this.stopping = true;
		this.polling.abort();
	}
	abortInFlight(): void {
		this.sending.abort();
	}
	private isStopping(): boolean {
		return this.stopping;
	}
	private log(record: Record<string, unknown>): void {
		this.diagnose({
			instanceId: this.config.instanceId,
			pid: process.pid,
			...record,
		});
	}

	async run(): Promise<void> {
		let failures = 0;
		let nextDiagnostic = 0;
		while (!this.isStopping()) {
			let wait = this.config.pollMs;
			try {
				if (Date.now() >= nextDiagnostic) {
					nextDiagnostic = Date.now() + 30000;
					try {
						const stats = await this.store.diagnostics();
						await this.publisher.check();
						this.log({
							event: 'publisher_diagnostics',
							loopActive: true,
							dependencies: 'OK',
							...stats,
							publishedLocal: this.publishedCount,
							retriesLocal: this.retryCount,
							lastError: this.lastError,
						});
					} catch {
						this.log({
							event: 'publisher_diagnostics',
							loopActive: true,
							dependencies: 'UNAVAILABLE',
						});
					}
				}
				if (this.isStopping()) break;
				const claims = await this.store.claim(
					this.config.batchSize,
					this.config.instanceId,
					this.config.leaseMs,
				);
				failures = 0;
				if (this.isStopping()) break;
				await Promise.all(claims.map(claim => this.publish(claim)));
				if (claims.length > 0) wait = 1;
			} catch {
				this.lastError = 'CLAIM_FAILED';
				this.log({ event: 'claim_failed', code: this.lastError });
				wait = retryDelay(
					++failures,
					this.config.backoffMinMs,
					this.config.backoffMaxMs,
				);
			}
			try {
				await delay(wait, undefined, { signal: this.polling.signal });
			} catch {
				if (!this.isStopping())
					throw new Error('Publisher polling interrupted');
			}
		}
	}

	async publish(claim: OutboxClaim): Promise<void> {
		const started = Date.now();
		const context = {
			...diagnosticIdentity(claim.payload.data),
			eventId: claim.eventId,
			eventType: claim.eventType,
			correlationId: claim.correlationId,
			attempt: claim.attempts,
		};
		this.log({
			event: claim.recovered ? 'claim_recovered' : 'event_claimed',
			...context,
			leaseExpired: claim.recovered,
			previousResultUncertain: claim.recovered,
		});
		try {
			await this.publisher.publish(claim, this.sending.signal);
		} catch (error) {
			const failure = publicationFailure(error);
			this.lastError = failure.code;
			this.retryCount++;
			const wait = failure.permanent
				? this.config.backoffMaxMs
				: retryDelay(
						claim.attempts,
						this.config.backoffMinMs,
						this.config.backoffMaxMs,
					);
			try {
				const result = await this.store.retry(
					claim,
					wait,
					failure.code,
				);
				this.log({
					event: 'publication_retry',
					...context,
					...failure,
					result,
					delayMs: wait,
					durationMs: Date.now() - started,
				});
			} catch {
				this.log({
					event: 'retry_persistence_failed',
					...context,
					code: 'SQL_UNCERTAIN',
					durationMs: Date.now() - started,
				});
			}
			return;
		}
		try {
			const result = await this.store.published(claim);
			if (result === 'UPDATED') this.publishedCount++;
			this.log({
				event: 'publication_confirmed',
				...context,
				result,
				durationMs: Date.now() - started,
			});
		} catch {
			this.lastError = 'FINALIZE_UNCERTAIN';
			this.log({
				event: 'finalization_failed',
				...context,
				code: this.lastError,
				durationMs: Date.now() - started,
			});
		}
	}
}
