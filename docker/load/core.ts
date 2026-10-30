import assert from 'node:assert/strict';

export interface Config {
	profile: 'quick' | 'standard';
	durationMs: number;
	warmupMs: number;
	concurrency: number;
	wallets: number;
	maxOperations: number;
	sqsRate: number;
	timeoutMs: number;
	drainMs: number;
}

export function configuration(env: Record<string, string | undefined>): Config {
	const profile = env.LOAD_PROFILE ?? 'quick';
	assert(
		profile === 'quick' || profile === 'standard',
		'Invalid LOAD_PROFILE',
	);
	const standard = profile === 'standard';
	const integer = (
		key: string,
		fallback: number,
		min: number,
		max: number,
	): number => {
		const raw =
			env[key] === undefined || env[key] === ''
				? String(fallback)
				: env[key];
		assert(/^\d+$/.test(raw), `Invalid ${key}`);
		const value = Number(raw);
		assert(
			Number.isSafeInteger(value) && value >= min && value <= max,
			`Invalid ${key}: ${String(min)}..${String(max)}`,
		);
		return value;
	};
	assert(
		env.LOAD_TARGET === undefined || env.LOAD_TARGET === 'demo',
		'LOAD_TARGET must be demo',
	);
	for (const [key, allowed] of Object.entries({
		API_BASE_URL: [
			'http://nginx:8080',
			'http://localhost:3000',
			'http://127.0.0.1:3000',
		],
		SQS_ENDPOINT: [
			'http://localstack:4566',
			'http://localhost:4566',
			'http://127.0.0.1:4566',
		],
		POSTGRES_HOST: ['postgres', 'localhost', '127.0.0.1'],
	})) {
		assert(
			env[key] === undefined || allowed.includes(env[key]),
			`${key} must target the Compose demo`,
		);
	}
	const config: Config = {
		profile,
		durationMs: integer(
			'LOAD_DURATION_MS',
			standard ? 30000 : 8000,
			1000,
			300000,
		),
		warmupMs: integer('LOAD_WARMUP_MS', standard ? 5000 : 2000, 0, 30000),
		concurrency: integer('LOAD_CONCURRENCY', standard ? 12 : 6, 2, 100),
		wallets: integer('LOAD_WALLETS', standard ? 24 : 12, 2, 1000),
		maxOperations: integer(
			'LOAD_MAX_OPERATIONS',
			standard ? 6000 : 600,
			10,
			100000,
		),
		sqsRate: integer('LOAD_SQS_RATE', standard ? 25 : 10, 1, 1000),
		timeoutMs: integer('LOAD_TIMEOUT_MS', 10000, 10, 60000),
		drainMs: integer(
			'LOAD_DRAIN_MS',
			standard ? 120000 : 60000,
			1000,
			300000,
		),
	};
	assert(
		config.wallets >= config.concurrency,
		'LOAD_WALLETS must be >= LOAD_CONCURRENCY (exclusive producer wallets)',
	);
	return config;
}

export interface Percentiles {
	samples: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
}
export function percentiles(values: readonly number[]): Percentiles {
	assert(
		values.every(value => Number.isFinite(value) && value >= 0),
		'Invalid latency sample',
	);
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p: number): number | null =>
		sorted[Math.ceil(sorted.length * p) - 1] ?? null;
	return {
		samples: sorted.length,
		p50: rank(0.5),
		p95: rank(0.95),
		p99: rank(0.99),
		max: sorted.at(-1) ?? null,
	};
}

export function throughput(
	completionsMs: readonly number[],
	windowMs: number,
): number {
	assert(
		Number.isFinite(windowMs) && windowMs > 0,
		'Invalid measurement window',
	);
	return (
		(completionsMs.filter(at => at >= 0 && at <= windowMs).length * 1000) /
		windowMs
	);
}

export type Category =
	| 'processed'
	| 'business'
	| 'validation'
	| 'infrastructure'
	| 'conflict'
	| 'technical'
	| 'pending'
	| 'timeout'
	| 'interrupted';
export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function classify(status: number, body: unknown): Category {
	const data = object(body);
	if (
		status === 200 &&
		data.status === 'PROCESSED' &&
		typeof data.transactionId === 'string' &&
		typeof data.idempotentReplay === 'boolean' &&
		typeof object(data.balance).amount === 'string'
	)
		return 'processed';
	if (
		status === 422 &&
		data.status === 'REJECTED' &&
		typeof data.transactionId === 'string' &&
		typeof data.failureCode === 'string' &&
		typeof data.idempotentReplay === 'boolean'
	)
		return 'business';
	if (
		status === 202 &&
		(data.status === 'PENDING' || data.status === 'PENDING_REFERENCE')
	)
		return 'pending';
	if (status === 409) return 'conflict';
	if (status === 503 || status === 502 || status === 504)
		return 'infrastructure';
	if (status >= 500) return 'technical';
	return 'validation';
}

export interface Observation {
	status: number | null;
	category: Category;
	latencyMs: number;
	body: unknown;
	upstream: string | null;
}
export async function request(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<Observation> {
	const start = performance.now();
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(url, {
			...init,
			redirect: 'manual',
			signal: AbortSignal.any([signal, timeout]),
		});
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			body = null;
		}
		return {
			status: response.status,
			body,
			category: classify(response.status, body),
			latencyMs: performance.now() - start,
			upstream: response.headers.get('X-Demo-Upstream'),
		};
	} catch {
		return {
			status: null,
			body: null,
			category: signal.aborted
				? 'interrupted'
				: timeout.aborted
					? 'timeout'
					: 'infrastructure',
			latencyMs: performance.now() - start,
			upstream: null,
		};
	}
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted || ms <= 0) return;
	await new Promise<void>(resolve => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

export async function produce(
	options: {
		concurrency: number;
		durationMs: number;
		maxOperations: number;
		signal: AbortSignal;
		rate?: number;
	},
	operation: (sequence: number, worker: number) => Promise<void>,
): Promise<{
	startedAt: number;
	windowMs: number;
	elapsedMs: number;
	submitted: number;
}> {
	const start = performance.now();
	let submitted = 0;
	let reserved = 0;
	let failed = false;
	const stopped = (): boolean => options.signal.aborted || failed;
	const results = await Promise.allSettled(
		Array.from({ length: options.concurrency }, async (_, worker) => {
			try {
				while (
					!stopped() &&
					reserved < options.maxOperations &&
					performance.now() - start < options.durationMs
				) {
					const sequence = reserved++;
					if (options.rate !== undefined)
						await pause(
							start +
								(sequence * 1000) / options.rate -
								performance.now(),
							options.signal,
						);
					if (
						stopped() ||
						performance.now() - start >= options.durationMs
					) {
						return;
					}
					submitted++;
					await operation(sequence, worker);
				}
			} catch (error) {
				failed = true;
				throw error;
			}
		}),
	);
	const failure = results.find(result => result.status === 'rejected');
	if (failure !== undefined)
		throw failure.reason instanceof Error
			? failure.reason
			: new Error('Producer failed');
	const elapsedMs = performance.now() - start;
	return {
		startedAt: start,
		windowMs: Math.min(elapsedMs, options.durationMs),
		elapsedMs,
		submitted,
	};
}

export function installShutdown(controller: AbortController): () => void {
	const interrupt = (): void => {
		controller.abort(new Error('SIGINT'));
	};
	const terminate = (): void => {
		controller.abort(new Error('SIGTERM'));
	};
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', terminate);
	return (): void => {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
	};
}

export function assertInvariant(
	condition: boolean,
	description: string,
): asserts condition {
	assert(condition, `CRITICAL financial invariant: ${description}`);
}
export function verdict(
	interrupted: boolean,
	errors: readonly string[],
	reconciled: boolean,
): 'PASS' | 'FAIL' | 'INCOMPLETE' {
	if (interrupted || !reconciled) return 'INCOMPLETE';
	return errors.length === 0 ? 'PASS' : 'FAIL';
}

export interface Report {
	status: string;
	runId: string;
	config: Config;
	metadata: Record<string, unknown>;
	scenarios: Record<string, unknown>[];
	errors: string[];
}

export function brokerDrained(
	depths: Record<string, number>,
	baselineDlq: number,
): boolean {
	const keys = [
		'ApproximateNumberOfMessages',
		'ApproximateNumberOfMessagesNotVisible',
		'ApproximateNumberOfMessagesDelayed',
	];
	const commands = keys.map(key => depths[`commands.${key}`]);
	const dlq = keys.map(key => depths[`dlq.${key}`]);
	return (
		commands.every(value => value === 0) &&
		dlq.every(
			value =>
				value !== undefined &&
				Number.isSafeInteger(value) &&
				value >= 0,
		) &&
		dlq.reduce<number>((sum, value) => sum + (value ?? 0), 0) ===
			baselineDlq
	);
}

export async function forwardUntilStarted(
	sendSignal: () => Promise<boolean>,
	running: () => boolean,
): Promise<void> {
	while (running()) {
		if (await sendSignal()) return;
		await Bun.sleep(100);
	}
}

export async function finalize(
	report: Report,
	signal: AbortSignal,
	close: () => Promise<void>,
	persist: () => Promise<void>,
): Promise<void> {
	try {
		await close();
	} catch (error) {
		report.errors.push(`Cleanup: ${String(error)}`);
		report.status = 'INCOMPLETE';
	}
	const markInterrupted = (): void => {
		if (signal.aborted) {
			report.status = 'INCOMPLETE';
			if (!report.errors.includes(String(signal.reason)))
				report.errors.push(String(signal.reason));
		}
	};
	markInterrupted();
	await persist();
	// A signal can arrive during file I/O after serialization of the first report.
	if (signal.aborted) {
		markInterrupted();
		await persist();
	}
}

export function renderReport(report: Report): string {
	const summaries = report.scenarios.map(scenario =>
		Object.fromEntries(
			Object.entries(scenario).filter(
				([key]) =>
					!['samples', 'observations', 'queueSamples'].includes(key),
			),
		),
	);
	return `# Distributed Wagering Processor — Load Test\n\nRun: ${report.runId}\n\nRESULT: ${report.status}\n\nRaw request and polling samples: adjacent JSON artifact.\n\n${summaries.map(scenario => `## ${String(scenario.name)}\n\n\u0060\u0060\u0060json\n${JSON.stringify(scenario, null, 2)}\n\u0060\u0060\u0060`).join('\n\n')}\n\n## Parameters and metadata\n\n\u0060\u0060\u0060json\n${JSON.stringify({ config: report.config, metadata: report.metadata, errors: report.errors }, null, 2)}\n\u0060\u0060\u0060\n`;
}
