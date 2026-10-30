export interface PendingWorkerConfig {
	readonly instanceId: string;
	readonly sqlMs: number;
	readonly concurrency: number;
	readonly batchSize: number;
	readonly pollMs: number;
	readonly leaseMs: number;
	readonly shutdownMs: number;
	readonly backoffMinMs: number;
	readonly backoffMaxMs: number;
	readonly ttlMs: number;
}

export function pendingWorkerConfig(
	env: NodeJS.ProcessEnv = process.env,
): PendingWorkerConfig {
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
	const instanceId = env.PENDING_INSTANCE_ID ?? crypto.randomUUID();
	if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(instanceId))
		throw new Error('Invalid PENDING_INSTANCE_ID');
	const config = {
		instanceId,
		sqlMs: integer('PENDING_SQL_MS', 5000),
		concurrency: integer('PENDING_CONCURRENCY', 4, 100),
		batchSize: integer('PENDING_BATCH_SIZE', 4, 100),
		pollMs: integer('PENDING_POLL_MS', 1000),
		leaseMs: integer('PENDING_LEASE_MS', 30000),
		shutdownMs: integer('PENDING_SHUTDOWN_MS', 30000),
		backoffMinMs: integer('PENDING_BACKOFF_MIN_MS', 1000),
		backoffMaxMs: integer('PENDING_BACKOFF_MAX_MS', 300000),
		ttlMs: integer('PENDING_TTL_MS', 86400000, 2592000000),
	};
	if (
		config.batchSize > config.concurrency ||
		config.backoffMinMs > config.backoffMaxMs ||
		config.leaseMs < 2 * config.sqlMs + 2000 ||
		config.shutdownMs < 2 * config.sqlMs + 2000
	)
		throw new Error('Incompatible pending worker budgets');
	return Object.freeze(config);
}

export function pendingBackoff(
	attempts: number,
	config: PendingWorkerConfig,
	random = Math.random(),
): number {
	const ceiling = Math.min(
		config.backoffMaxMs,
		config.backoffMinMs * 2 ** Math.min(Math.max(0, attempts - 1), 32),
	);
	return Math.floor(
		config.backoffMinMs + random * (ceiling - config.backoffMinMs),
	);
}
