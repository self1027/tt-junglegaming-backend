import {
	SQSClient,
	CreateQueueCommand,
	GetQueueAttributesCommand,
	SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { sqsConfig } from './sqs-config.js';

/** Explicit development/test operation; never called by API or consumer startup. */
export async function provisionSqs(
	client: SQSClient,
	name = 'wager-transactions',
	maxReceiveCount = 5,
	visibility = 60,
): Promise<{ queueUrl: string; dlqUrl: string }> {
	const dlq = await client.send(
		new CreateQueueCommand({
			QueueName: `${name}-dlq.fifo`,
			Attributes: {
				FifoQueue: 'true',
				ContentBasedDeduplication: 'false',
				MessageRetentionPeriod: '1209600',
			},
		}),
	);
	if (dlq.QueueUrl === undefined) throw new Error('Missing DLQ URL');
	const attrs = await client.send(
		new GetQueueAttributesCommand({
			QueueUrl: dlq.QueueUrl,
			AttributeNames: ['QueueArn'],
		}),
	);
	const input = await client.send(
		new CreateQueueCommand({
			QueueName: `${name}.fifo`,
			Attributes: {
				FifoQueue: 'true',
				ContentBasedDeduplication: 'false',
				MessageRetentionPeriod: '345600',
				ReceiveMessageWaitTimeSeconds: '20',
				VisibilityTimeout: String(visibility),
				RedrivePolicy: JSON.stringify({
					deadLetterTargetArn: attrs.Attributes?.QueueArn,
					maxReceiveCount,
				}),
			},
		}),
	);
	if (input.QueueUrl === undefined) throw new Error('Missing input URL');
	const source = await client.send(
		new GetQueueAttributesCommand({
			QueueUrl: input.QueueUrl,
			AttributeNames: ['QueueArn'],
		}),
	);
	await client.send(
		new SetQueueAttributesCommand({
			QueueUrl: dlq.QueueUrl,
			Attributes: {
				RedriveAllowPolicy: JSON.stringify({
					redrivePermission: 'byQueue',
					sourceQueueArns: [source.Attributes?.QueueArn],
				}),
			},
		}),
	);
	return { queueUrl: input.QueueUrl, dlqUrl: dlq.QueueUrl };
}

export async function provisionEventsQueue(
	client: SQSClient,
	name = 'wager-events',
): Promise<string> {
	const result = await client.send(
		new CreateQueueCommand({
			QueueName: `${name}.fifo`,
			Attributes: {
				FifoQueue: 'true',
				ContentBasedDeduplication: 'false',
				MessageRetentionPeriod: '1209600',
			},
		}),
	);
	if (result.QueueUrl === undefined) throw new Error('Missing events URL');
	return result.QueueUrl;
}

if (import.meta.main) {
	if (process.env.SQS_ENDPOINT === undefined)
		throw new Error(
			'Explicit local SQS_ENDPOINT required for provisioning',
		);
	const config = sqsConfig();
	const client = new SQSClient({
		region: config.region,
		endpoint: process.env.SQS_ENDPOINT,
	});
	try {
		console.log(
			JSON.stringify(
				await provisionSqs(
					client,
					'wager-transactions',
					config.maxReceiveCount,
					config.visibilitySeconds,
				),
			),
		);
		console.log(
			JSON.stringify({
				eventsQueueUrl: await provisionEventsQueue(client),
			}),
		);
	} finally {
		client.destroy();
	}
}
