export interface PublisherConfig {
	readonly region: string;
	readonly endpoint: string | undefined;
	readonly eventsQueueUrl: string;
	readonly instanceId: string;
	readonly timeoutMs: number;
	readonly sqlMs: number;
	readonly concurrency: number;
	readonly batchSize: number;
	readonly pollMs: number;
	readonly leaseMs: number;
	readonly shutdownMs: number;
	readonly backoffMinMs: number;
	readonly backoffMaxMs: number;
}

export function publisherConfig(
	env: NodeJS.ProcessEnv = process.env,
): PublisherConfig {
	const integer = (key: string, fallback: number, max = 3600000): number => {
		const raw = env[key] ?? String(fallback);
		const value = Number(raw);
		if (
			!/^\d+$/.test(raw) ||
			!Number.isSafeInteger(value) ||
			value < 1 ||
			value > max
		)
			throw new Error(`Invalid ${key}`);
		return value;
	};
	const url = (key: string, fifo: boolean): string => {
		const raw = env[key];
		if (raw === undefined) throw new Error(`Missing ${key}`);
		const parsed = new URL(raw);
		if (
			!['http:', 'https:'].includes(parsed.protocol) ||
			parsed.username !== '' ||
			parsed.password !== '' ||
			parsed.search !== '' ||
			parsed.hash !== '' ||
			(fifo && !parsed.pathname.endsWith('.fifo'))
		)
			throw new Error(`Invalid ${key}`);
		return raw;
	};
	const region = env.AWS_REGION;
	if (region === undefined || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
		throw new Error('Invalid AWS_REGION');
	const instanceId = env.PUBLISHER_INSTANCE_ID ?? crypto.randomUUID();
	if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(instanceId))
		throw new Error('Invalid PUBLISHER_INSTANCE_ID');
	const config = {
		region,
		endpoint:
			env.SQS_ENDPOINT === undefined
				? undefined
				: url('SQS_ENDPOINT', false),
		eventsQueueUrl: url('SQS_EVENTS_QUEUE_URL', true),
		instanceId,
		timeoutMs: integer('PUBLISHER_TIMEOUT_MS', 10000),
		sqlMs: integer('PUBLISHER_SQL_MS', 5000),
		concurrency: integer('PUBLISHER_CONCURRENCY', 4, 100),
		batchSize: integer('PUBLISHER_BATCH_SIZE', 4, 100),
		pollMs: integer('PUBLISHER_POLL_MS', 1000),
		leaseMs: integer('PUBLISHER_LEASE_MS', 30000),
		shutdownMs: integer('PUBLISHER_SHUTDOWN_MS', 30000),
		backoffMinMs: integer('PUBLISHER_BACKOFF_MIN_MS', 1000),
		backoffMaxMs: integer('PUBLISHER_BACKOFF_MAX_MS', 300000),
	};
	const queue = new URL(config.eventsQueueUrl);
	for (const key of ['SQS_QUEUE_URL', 'SQS_DLQ_URL']) {
		const other = env[key];
		if (
			other !== undefined &&
			new URL(other).pathname.replace(/\/$/, '') === queue.pathname
		)
			throw new Error('Events queue must be distinct from input and DLQ');
	}
	if (
		config.batchSize > config.concurrency ||
		config.backoffMinMs > config.backoffMaxMs ||
		config.leaseMs < config.timeoutMs + 2 * config.sqlMs + 1000
	)
		throw new Error('Incompatible publisher budgets');
	return Object.freeze(config);
}
