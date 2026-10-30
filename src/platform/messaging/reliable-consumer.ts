import { setTimeout as delay } from 'node:timers/promises';
import { PermanentMessageError } from './transport.js';
import type {
	MessageOutcome,
	MessageTransport,
	ReceivedMessage,
} from './transport.js';
import type { SqsConfig } from './sqs-config.js';
import { diagnostic } from '../observability/diagnostic.js';

export class ReliableConsumer {
	private stopping = false;
	private readonly polling = new AbortController();
	private nextDiagnostic = 0;

	constructor(
		private readonly transport: MessageTransport,
		private readonly config: SqsConfig,
		private readonly handle: (
			message: ReceivedMessage,
		) => Promise<MessageOutcome>,
		private readonly diagnose: (
			record: Record<string, unknown>,
		) => void = diagnostic,
	) {}

	requestStop(): void {
		this.stopping = true;
		this.polling.abort();
	}
	private isStopping(): boolean {
		return this.stopping;
	}

	async run(): Promise<void> {
		await Promise.all(
			Array.from({ length: this.config.concurrency }, () => this.poll()),
		);
	}

	private async poll(): Promise<void> {
		let failures = 0;
		while (!this.isStopping()) {
			try {
				if (Date.now() >= this.nextDiagnostic) {
					this.nextDiagnostic = Date.now() + 30000;
					try {
						await this.transport.check();
					} catch {
						this.diagnose({
							event: 'sqs_diagnostics_failed',
							pid: process.pid,
						});
					}
				}
				if (this.isStopping()) break;
				// One receipt per call prevents poison from spending successors' redrive attempts.
				const messages = await this.transport.receive(
					1,
					this.polling.signal,
				);
				failures = 0;
				await this.consumeBatch(messages);
			} catch {
				if (this.isStopping()) break;
				this.diagnose({ event: 'poll_failed', pid: process.pid });
				failures++;
				try {
					await delay(
						Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)),
						undefined,
						{ signal: this.polling.signal },
					);
				} catch {
					if (!this.isStopping())
						throw new Error('Polling backoff interrupted');
				}
			}
		}
	}

	async consumeBatch(messages: readonly ReceivedMessage[]): Promise<void> {
		if (messages.length === 0) return;
		const pending = new Set(messages);
		const groups = new Map<string, ReceivedMessage[]>();
		for (const message of messages) {
			const group = groups.get(message.groupId) ?? [];
			group.push(message);
			groups.set(message.groupId, group);
		}
		const started = Date.now();
		let visibilityLost = false;
		const leaseValid = (): boolean =>
			!visibilityLost && Date.now() - started < this.config.processingMs;
		let renewing = false;
		let renewal = Promise.resolve();
		const renew = async (): Promise<void> => {
			if (visibilityLost) return;
			if (Date.now() - started >= this.config.processingMs) {
				visibilityLost = true;
				this.diagnose({
					event: 'processing_deadline',
					pid: process.pid,
				});
				return;
			}
			await Promise.all(
				[...pending].map(async message => {
					try {
						await this.transport.visibility(
							message,
							Math.min(
								this.config.visibilitySeconds,
								Math.max(
									1,
									Math.ceil(
										(this.config.processingMs -
											(Date.now() - started)) /
											1000,
									),
								),
							),
						);
					} catch {
						visibilityLost = true;
						this.log('visibility_failed', message);
					}
				}),
			);
		};
		const timer = setInterval(
			() => {
				if (renewing) return;
				renewing = true;
				renewal = renew().finally(() => {
					renewing = false;
				});
			},
			Math.max(
				100,
				Math.floor((this.config.visibilitySeconds * 1000) / 3),
			),
		);
		try {
			await Promise.all(
				[...groups.values()].map(async group => {
					let blocked = false;
					for (const message of group) {
						if (this.isStopping() || !leaseValid() || blocked) {
							pending.delete(message);
							if (this.stopping && !blocked)
								await this.retry(message, 0);
							else
								await this.retry(
									message,
									this.retrySeconds(message),
								);
							continue;
						}
						const at = Date.now();
						let outcome: MessageOutcome;
						try {
							outcome = await this.handle(message);
						} catch (error) {
							blocked = true;
							this.log('processing_failed', message, {
								classification:
									error instanceof PermanentMessageError
										? 'permanent'
										: 'transient',
								code:
									error instanceof PermanentMessageError
										? error.code
										: 'TECHNICAL_FAILURE',
							});
							pending.delete(message);
							await this.retry(
								message,
								this.retrySeconds(message),
							);
							continue;
						}
						this.log('committed', message, {
							...outcome,
							latencyMs: Date.now() - at,
						});
						if (leaseValid()) {
							try {
								await this.transport.ack(message);
								this.log('acked', message, { ...outcome });
							} catch {
								blocked = true;
								this.log('ack_failed', message, { ...outcome });
							}
						} else blocked = true;
						pending.delete(message);
					}
				}),
			);
		} finally {
			clearInterval(timer);
			await renewal;
		}
	}

	private retrySeconds(message: ReceivedMessage): number {
		return Math.min(
			this.config.visibilitySeconds,
			2 ** Math.min(message.receiveCount, 8),
		);
	}
	private async retry(
		message: ReceivedMessage,
		seconds: number,
	): Promise<void> {
		this.log('message_retry', message, { delaySeconds: seconds });
		try {
			await this.transport.visibility(message, seconds);
		} catch {
			this.log('retry_visibility_failed', message);
		}
	}
	private log(
		event: string,
		message: ReceivedMessage,
		fields: Record<string, unknown> = {},
	): void {
		this.diagnose({
			event,
			pid: process.pid,
			sqsMessageId: message.nativeId,
			receiveCount: message.receiveCount,
			...fields,
		});
	}
}
