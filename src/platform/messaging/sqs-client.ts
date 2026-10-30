import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient(
	config: { readonly region: string; readonly endpoint: string | undefined },
	requestTimeout: number,
	maxAttempts: number,
): SQSClient {
	return new SQSClient({
		region: config.region,
		...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
		maxAttempts,
		requestHandler: { connectionTimeout: 3000, requestTimeout },
	});
}
