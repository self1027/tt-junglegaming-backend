import {
	GetQueueAttributesCommand,
	SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type {
	EventPublisher,
	OutboxEvent,
} from '../../../../platform/messaging/outbox.js';
import type { PublisherConfig } from '../../../../platform/messaging/publisher-config.js';
import { createSqsClient } from '../../../../platform/messaging/sqs-client.js';
import { persistedEvent } from './persisted-event.js';

export class SqsEventPublisher implements EventPublisher {
	private readonly client: SQSClient;
	constructor(private readonly config: PublisherConfig) {
		this.client = createSqsClient(config, config.timeoutMs, 1);
	}
	async publish(event: OutboxEvent, signal: AbortSignal): Promise<void> {
		const message = persistedEvent(event);
		const result = await this.client.send(
			new SendMessageCommand({
				QueueUrl: this.config.eventsQueueUrl,
				MessageBody: message.body,
				MessageGroupId: message.groupId,
				MessageDeduplicationId: message.deduplicationId,
			}),
			{
				abortSignal: AbortSignal.any([
					signal,
					AbortSignal.timeout(this.config.timeoutMs),
				]),
			},
		);
		if (
			result.MessageId === undefined ||
			result.SequenceNumber === undefined
		)
			throw new Error('Unconfirmed SQS publish');
	}
	async check(): Promise<void> {
		const result = await this.client.send(
			new GetQueueAttributesCommand({
				QueueUrl: this.config.eventsQueueUrl,
				AttributeNames: ['FifoQueue'],
			}),
			{ abortSignal: AbortSignal.timeout(this.config.timeoutMs) },
		);
		if (result.Attributes?.FifoQueue !== 'true')
			throw new Error('Events queue is not FIFO');
	}
	close(): void {
		this.client.destroy();
	}
	onModuleDestroy(): void {
		this.close();
	}
}
