import {
	ReceiveMessageCommand,
	DeleteMessageCommand,
	ChangeMessageVisibilityCommand,
	GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import type { SqsConfig } from './sqs-config.js';
import type { MessageTransport, ReceivedMessage } from './transport.js';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from './sqs-client.js';

export class SqsTransport implements MessageTransport {
	private readonly client: SQSClient;

	constructor(private readonly config: SqsConfig) {
		this.client = createSqsClient(
			config,
			(config.waitSeconds + 5) * 1000,
			2,
		);
	}

	async receive(
		max: number,
		signal: AbortSignal,
	): Promise<readonly ReceivedMessage[]> {
		const result = await this.client.send(
			new ReceiveMessageCommand({
				QueueUrl: this.config.queueUrl,
				MaxNumberOfMessages: max,
				WaitTimeSeconds: this.config.waitSeconds,
				VisibilityTimeout: this.config.visibilitySeconds,
				MessageSystemAttributeNames: [
					'MessageGroupId',
					'MessageDeduplicationId',
					'ApproximateReceiveCount',
				],
			}),
			{
				abortSignal: AbortSignal.any([
					signal,
					AbortSignal.timeout((this.config.waitSeconds + 5) * 1000),
				]),
			},
		);
		return (result.Messages ?? []).map(message => {
			const { Body, MessageId, ReceiptHandle, Attributes } = message;
			const groupId = Attributes?.MessageGroupId;
			const deduplicationId = Attributes?.MessageDeduplicationId;
			const receiveCount = Number(Attributes?.ApproximateReceiveCount);
			if (
				Body === undefined ||
				MessageId === undefined ||
				ReceiptHandle === undefined ||
				groupId === undefined ||
				deduplicationId === undefined ||
				!Number.isSafeInteger(receiveCount) ||
				receiveCount < 1
			)
				throw new Error('Incomplete SQS receipt');
			return {
				body: Body,
				nativeId: MessageId,
				receiptHandle: ReceiptHandle,
				groupId,
				deduplicationId,
				receiveCount,
			};
		});
	}

	async ack(message: ReceivedMessage): Promise<void> {
		await this.client.send(
			new DeleteMessageCommand({
				QueueUrl: this.config.queueUrl,
				ReceiptHandle: message.receiptHandle,
			}),
			{ abortSignal: AbortSignal.timeout(5000) },
		);
	}

	async visibility(message: ReceivedMessage, seconds: number): Promise<void> {
		await this.client.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: this.config.queueUrl,
				ReceiptHandle: message.receiptHandle,
				VisibilityTimeout: seconds,
			}),
			{ abortSignal: AbortSignal.timeout(5000) },
		);
	}

	async check(): Promise<void> {
		const [input, dlq] = await Promise.all([
			this.client.send(
				new GetQueueAttributesCommand({
					QueueUrl: this.config.queueUrl,
					AttributeNames: ['FifoQueue', 'RedrivePolicy', 'QueueArn'],
				}),
				{ abortSignal: AbortSignal.timeout(3000) },
			),
			this.client.send(
				new GetQueueAttributesCommand({
					QueueUrl: this.config.dlqUrl,
					AttributeNames: [
						'FifoQueue',
						'QueueArn',
						'RedriveAllowPolicy',
					],
				}),
				{ abortSignal: AbortSignal.timeout(3000) },
			),
		]);
		const policy: unknown = JSON.parse(
			input.Attributes?.RedrivePolicy ?? 'null',
		);
		const allow: unknown = JSON.parse(
			dlq.Attributes?.RedriveAllowPolicy ??
				'{"redrivePermission":"allowAll"}',
		);
		const sourceArn = input.Attributes?.QueueArn;
		if (
			sourceArn === undefined ||
			dlq.Attributes?.QueueArn === undefined ||
			typeof allow !== 'object' ||
			allow === null ||
			!('redrivePermission' in allow) ||
			!(
				allow.redrivePermission === 'allowAll' ||
				(allow.redrivePermission === 'byQueue' &&
					'sourceQueueArns' in allow &&
					Array.isArray(allow.sourceQueueArns) &&
					allow.sourceQueueArns.includes(sourceArn))
			)
		)
			throw new Error('SQS DLQ redrive permission mismatch');
		if (
			input.Attributes?.FifoQueue !== 'true' ||
			dlq.Attributes.FifoQueue !== 'true' ||
			typeof policy !== 'object' ||
			policy === null ||
			!('deadLetterTargetArn' in policy) ||
			policy.deadLetterTargetArn !== dlq.Attributes.QueueArn ||
			!('maxReceiveCount' in policy) ||
			Number(policy.maxReceiveCount) !== this.config.maxReceiveCount
		)
			throw new Error('SQS FIFO/redrive configuration mismatch');
	}

	close(): void {
		this.client.destroy();
	}
	onModuleDestroy(): void {
		this.close();
	}
}
