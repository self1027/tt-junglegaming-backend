import { SQSClient } from '@aws-sdk/client-sqs';
import { provisionSqs } from '../../src/platform/messaging/provision-sqs.js';
import { command } from './postgres.js';

export interface TestSqs {
	readonly network: string;
	readonly env: NodeJS.ProcessEnv;
	readonly client: SQSClient;
	readonly queueUrl: string;
	readonly dlqUrl: string;
	control(action: 'stop' | 'start' | 'pause' | 'unpause'): Promise<void>;
	close(): Promise<void>;
}

export async function startSqs(): Promise<TestSqs> {
	const project = `dwp-sqs-${crypto.randomUUID()}`;
	const env = {
		...process.env,
		SQS_PORT: '0',
		AWS_REGION: 'us-east-1',
		AWS_ACCESS_KEY_ID: 'test',
		AWS_SECRET_ACCESS_KEY: 'test',
	};
	const compose = [
		'docker',
		'compose',
		'--project-name',
		project,
		'--env-file',
		'.env.example',
		'--profile',
		'sqs',
	];
	let client: SQSClient | undefined;
	const close = async (): Promise<void> => {
		client?.destroy();
		await command(
			[...compose, 'down', '--volumes', '--remove-orphans'],
			env,
		);
	};
	try {
		await command(
			[
				...compose,
				'up',
				'-d',
				'--wait',
				'--wait-timeout',
				'90',
				'localstack',
			],
			env,
		);
		const address = await command(
			[...compose, 'port', 'localstack', '4566'],
			env,
		);
		const port = address.split(':').at(-1);
		if (port === undefined || !/^\d+$/.test(port))
			throw new Error('Missing test SQS port');
		const endpoint = `http://127.0.0.1:${port}`;
		client = new SQSClient({
			region: env.AWS_REGION,
			endpoint,
			credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
			maxAttempts: 1,
		});
		const queues = await provisionSqs(
			client,
			`wager-${crypto.randomUUID()}`,
			3,
			2,
		);
		return {
			...queues,
			client,
			network: `${project}_default`,
			env: {
				...env,
				SQS_ENDPOINT: endpoint,
				SQS_QUEUE_URL: queues.queueUrl,
				SQS_DLQ_URL: queues.dlqUrl,
				SQS_WAIT_SECONDS: '1',
				SQS_VISIBILITY_SECONDS: '2',
				SQS_MAX_RECEIVE_COUNT: '3',
				SQS_SHUTDOWN_MS: '5000',
				SQS_PROCESSING_MS: '15000',
			},
			control: async (action): Promise<void> => {
				await command([...compose, action, 'localstack'], env);
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
