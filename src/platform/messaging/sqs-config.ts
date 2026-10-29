export interface SqsConfig {
	readonly region: string;
	readonly endpoint: string | undefined;
	readonly queueUrl: string;
	readonly dlqUrl: string;
	readonly waitSeconds: number;
	readonly visibilitySeconds: number;
	readonly batchSize: number;
	readonly concurrency: number;
	readonly processingMs: number;
	readonly shutdownMs: number;
	readonly maxReceiveCount: number;
}

export function sqsConfig(env: NodeJS.ProcessEnv = process.env): SqsConfig {
	const integer = (
		name: string,
		fallback: number,
		min: number,
		max: number,
	): number => {
		const raw = env[name] ?? String(fallback);
		const value = Number(raw);
		if (
			!/^\d+$/.test(raw) ||
			!Number.isSafeInteger(value) ||
			value < min ||
			value > max
		)
			throw new Error(`Invalid ${name}`);
		return value;
	};
	const url = (name: string, fifo: boolean): string => {
		const raw = env[name];
		if (raw === undefined) throw new Error(`Missing ${name}`);
		const parsed = new URL(raw);
		if (
			!['http:', 'https:'].includes(parsed.protocol) ||
			parsed.username !== '' ||
			parsed.password !== '' ||
			parsed.search !== '' ||
			parsed.hash !== '' ||
			(fifo && !parsed.pathname.endsWith('.fifo'))
		)
			throw new Error(`Invalid ${name}`);
		return raw;
	};
	const region = env.AWS_REGION;
	if (region === undefined || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
		throw new Error('Invalid AWS_REGION');
	const config = {
		region,
		endpoint:
			env.SQS_ENDPOINT === undefined
				? undefined
				: url('SQS_ENDPOINT', false),
		queueUrl: url('SQS_QUEUE_URL', true),
		dlqUrl: url('SQS_DLQ_URL', true),
		waitSeconds: integer('SQS_WAIT_SECONDS', 20, 0, 20),
		visibilitySeconds: integer('SQS_VISIBILITY_SECONDS', 60, 1, 43200),
		batchSize: integer('SQS_BATCH_SIZE', 1, 1, 1),
		concurrency: integer('SQS_CONCURRENCY', 4, 1, 100),
		processingMs: integer('SQS_PROCESSING_MS', 120000, 1000, 3600000),
		shutdownMs: integer('SQS_SHUTDOWN_MS', 30000, 1, 3600000),
		maxReceiveCount: integer('SQS_MAX_RECEIVE_COUNT', 5, 1, 1000),
	};
	if (config.queueUrl === config.dlqUrl)
		throw new Error('Input and DLQ must be distinct');
	return Object.freeze(config);
}
