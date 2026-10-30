import { sqsConfig } from '../platform/messaging/sqs-config.js';
import { SqsTransport } from '../platform/messaging/sqs-transport.js';

export const SQS_TRANSPORT = Symbol('SqsTransport');

export function optionalSqsTransport(): SqsTransport | null {
	return process.env.SQS_QUEUE_URL === undefined
		? null
		: new SqsTransport(sqsConfig());
}
