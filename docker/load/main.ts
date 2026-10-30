import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { readFile, mkdir } from 'node:fs/promises';
import {
	cpus,
	totalmem,
	freemem,
	platform,
	release,
	availableParallelism,
} from 'node:os';
import {
	SQSClient,
	SendMessageCommand,
	GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
	configuration,
	object,
	request,
	produce,
	pause,
	percentiles,
	throughput,
	installShutdown,
	assertInvariant,
	verdict,
	renderReport,
	finalize,
	brokerDrained,
} from './core.js';
import type { Config, Observation, Report } from './core.js';
import { Observer } from './observer.js';
import type { Point } from './observer.js';

const queue = 'http://localstack:4566/000000000000/wager-transactions.fifo';
const eventQueue = 'http://localstack:4566/000000000000/wager-events.fifo';
const dlq = 'http://localstack:4566/000000000000/wager-transactions-dlq.fifo';
const base = 'http://nginx:8080';
interface Wallet {
	id: string;
	playerId: string;
}
interface Wager {
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: { amount: string; currency: string };
}
interface Sample extends Point {
	elapsedMs: number;
}
interface HttpSample {
	elapsedMs: number;
	result: Observation;
}

async function optionalFile(path: string): Promise<string | null> {
	try {
		return (await readFile(path, 'utf8')).trim();
	} catch {
		return null;
	}
}
async function metadata(): Promise<Record<string, unknown>> {
	const head = await optionalFile('.git/HEAD');
	const ref = head?.startsWith('ref: ') === true ? head.slice(5) : null;
	const packed = await optionalFile('.git/packed-refs');
	const commit =
		ref === null
			? head
			: ((await optionalFile(`.git/${ref}`)) ??
				packed
					?.split('\n')
					.find(line => line.endsWith(` ${ref}`))
					?.split(' ')[0] ??
				null);
	return {
		startedAt: new Date().toISOString(),
		commit,
		branch: ref?.replace('refs/heads/', '') ?? null,
		bun: Bun.version,
		driverOS: `${platform()} ${release()}`,
		cpu: cpus()[0]?.model ?? null,
		logicalCPUs: cpus().length,
		availableParallelism: availableParallelism(),
		memoryBytes: totalmem(),
		freeMemoryBytes: freemem(),
		driverCgroupMemoryMax: await optionalFile('/sys/fs/cgroup/memory.max'),
		driverCgroupCpuMax: await optionalFile('/sys/fs/cgroup/cpu.max'),
		host:
			process.env.LOAD_HOST_METADATA === undefined
				? null
				: (JSON.parse(process.env.LOAD_HOST_METADATA) as unknown),
		composeImages:
			(await optionalFile('compose.demo.yaml'))
				?.split('\n')
				.filter(line => line.includes('image:'))
				.map(line => line.trim()) ?? [],
		applicationResourceLimits:
			'No explicit CPU/memory limits in compose.demo.yaml; Docker Desktop/daemon limits may apply.',
		percentiles:
			'Nearest rank: sorted samples[ceil(p*n)-1]; PostgreSQL percentile_disc for persisted intervals. No interpolation; empty sets are null.',
		methodology:
			'Closed loop, bounded concurrency; HTTP successes completed inside the window / window seconds. Requests crossing the cutoff remain in latency/error counts, separately excluded from in-window throughput. Warm-up has separate providers. No pseudo-random workload.',
		limitations: [
			'LocalStack is not AWS SQS performance. One run is not a capacity or linear scalability claim.',
			'Outbox created_at is PostgreSQL transaction start, published_at is SQL marking after confirmed SQS acceptance. The interval includes precommit time, polling, send and finalize; exact commit-to-accept latency is unavailable.',
			'PUBLISHED plus exact per-operation Outbox facts proves no loss through confirmed broker acceptance within this run. Events are not consumed; downstream durability/deduplication is not tested.',
			'HTTP sanitizes SQLSTATE. SQL conflict count is unavailable; database-wide deadlock deltas and sampled lock waiters are reported separately. Sampling can miss short waits and claims.',
			'Inbox attempts counts committed participations, not rolled-back retries or ACKs. Outbox extra claims include recovery, not necessarily failed network sends.',
			'SQS queue attributes are approximate and global, including events from earlier runs. SQL backlog is exact and scoped to the scenario provider.',
			'Asynchronous latency is monotonic send-start to first SQL observation of a committed PROCESSED transaction, sampled every 250ms in batches of at most 1000 pending IDs. It is an upper bound including observation delay and excludes ACK/publication. Application created_at and processed_at share the same timestamp and cannot measure execution latency.',
			'Database observations add read load every 250ms. Benchmark and services share hardware. No isolated bottleneck attribution or continuous host CPU/I/O profiling.',
			'Financial reconciliation uses SQL aggregates specialized for positive openings and unit BETs, including continuity, exact sums, per-operation effects and events. It does not change the application reconciliation endpoint.',
		],
	};
}

export async function main(): Promise<number> {
	let config: Config;
	try {
		config = configuration(process.env);
		assert(
			process.env.LOAD_TARGET === 'demo',
			'Explicit LOAD_TARGET=demo required; use the Compose load service',
		);
	} catch (error) {
		console.error(`Benchmark validation: ${String(error)}`);
		return 1;
	}
	const controller = new AbortController();
	const cleanup = installShutdown(controller);
	const signal = controller.signal;
	const runId = `load-${crypto.randomUUID()}`;
	const report: Report = {
		runId,
		config,
		status: 'INCOMPLETE',
		metadata: {},
		scenarios: [],
		errors: [],
	};
	const observer = new Observer();
	const sqs = new SQSClient({
		endpoint: 'http://localstack:4566',
		region: 'us-east-1',
		credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
		maxAttempts: 1,
		requestHandler: {
			requestTimeout: config.timeoutMs,
			connectionTimeout: Math.min(config.timeoutMs, 3000),
		},
	});
	const expectedUpstreams = new Set<string>();
	const initial = `${String(BigInt(config.maxOperations) * 2n + 10n)}.00`;
	let reconciled = 0;
	const checkSignal = (): void => {
		signal.throwIfAborted();
	};
	const save = async (): Promise<void> => {
		await mkdir('load-results', { recursive: true });
		await Bun.write(
			`load-results/${runId}.json`,
			JSON.stringify(report, null, 2),
		);
		await Bun.write(`load-results/${runId}.md`, renderReport(report));
	};
	const http = async (
		path: string,
		body?: unknown,
		key?: string,
	): Promise<Observation> => {
		const response = await request(
			`${base}${path}`,
			{
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(key === undefined ? {} : { 'Idempotency-Key': key }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			config.timeoutMs,
			signal,
		);
		if (response.status !== null) {
			const upstream = response.upstream?.split(',').at(-1)?.trim() ?? '';
			if (!expectedUpstreams.has(upstream))
				response.category = 'validation';
			response.upstream = upstream;
		}
		return response;
	};
	const createWallets = async (count: number): Promise<Wallet[]> => {
		const wallets: Wallet[] = [];
		for (let i = 0; i < count; i++) {
			checkSignal();
			const playerId = `${runId}-${crypto.randomUUID()}`;
			const response = await http('/wallets', {
				playerId,
				initialBalance: { amount: initial, currency: 'BRL' },
			});
			assert(
				response.status === 201 &&
					expectedUpstreams.has(response.upstream ?? ''),
				'Wallet preparation failed',
			);
			const id = object(response.body).id;
			assert(
				typeof id === 'string' && /^[\da-f-]{36}$/.test(id),
				'Invalid wallet response',
			);
			wallets.push({ id, playerId });
		}
		return wallets;
	};
	const wager = (wallet: Wallet, provider: string, id: string): Wager => ({
		providerId: provider,
		externalTransactionId: id,
		walletId: wallet.id,
		playerId: wallet.playerId,
		roundId: 'load-round',
		gameId: 'load-test',
		kind: 'BET',
		money: { amount: '1.00', currency: 'BRL' },
	});
	const submit = (body: Wager): Promise<Observation> =>
		http(
			'/wagering/transactions',
			body,
			`${body.providerId}:${body.externalTransactionId}`,
		);
	const send = async (body: Wager): Promise<Observation> => {
		const start = performance.now();
		const timeout = AbortSignal.timeout(config.timeoutMs);
		try {
			const messageId = `${body.providerId}:${body.externalTransactionId}`;
			const result = await sqs.send(
				new SendMessageCommand({
					QueueUrl: queue,
					MessageGroupId: body.walletId,
					MessageDeduplicationId: messageId,
					MessageBody: JSON.stringify({
						messageId,
						type: 'WagerTransactionRequested',
						occurredAt: new Date().toISOString(),
						data: { ...body, idempotencyKey: messageId },
					}),
				}),
				{
					abortSignal: AbortSignal.any([signal, timeout]),
				},
			);
			assert(
				result.MessageId !== undefined &&
					result.SequenceNumber !== undefined,
				'SQS did not confirm submission',
			);
			return {
				status: 200,
				category: 'processed',
				body: null,
				upstream: null,
				latencyMs: performance.now() - start,
			};
		} catch (error) {
			return {
				status: null,
				category: signal.aborted
					? 'interrupted'
					: timeout.aborted ||
						  String(error).toLowerCase().includes('timeout')
						? 'timeout'
						: 'infrastructure',
				body: null,
				upstream: null,
				latencyMs: performance.now() - start,
			};
		}
	};
	const queueDepth = async (): Promise<Record<string, number>> => {
		const depths: Record<string, number> = {};
		for (const [name, url] of [
			['commands', queue],
			['events', eventQueue],
			['dlq', dlq],
		] as const) {
			const result = await sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: url,
					AttributeNames: [
						'ApproximateNumberOfMessages',
						'ApproximateNumberOfMessagesNotVisible',
						'ApproximateNumberOfMessagesDelayed',
					],
				}),
				{
					abortSignal: AbortSignal.any([
						signal,
						AbortSignal.timeout(config.timeoutMs),
					]),
				},
			);
			for (const [key, value] of Object.entries(result.Attributes ?? {}))
				depths[`${name}.${key}`] = Number(value);
		}
		return depths;
	};
	let baselineDlq = 0;
	const drain = async (
		provider: string,
		expected: number,
		asynchronous: boolean,
		onPoint?: (point: Point) => Promise<void>,
	): Promise<{ point: Point; drainMs: number }> => {
		const start = performance.now();
		let emptyBrokerSamples = 0;
		while (performance.now() - start < config.drainMs) {
			checkSignal();
			const point = await observer.point(provider);
			await onPoint?.(point);
			if (
				point.confirmed === expected &&
				point.transactions === expected &&
				point.events === expected * 2 &&
				point.published === expected * 2 &&
				(!asynchronous || point.inboxProcessed === expected)
			) {
				if (!asynchronous)
					return { point, drainMs: performance.now() - start };
				const depths = await queueDepth();
				emptyBrokerSamples = brokerDrained(depths, baselineDlq)
					? emptyBrokerSamples + 1
					: 0;
				if (emptyBrokerSamples >= 2)
					return { point, drainMs: performance.now() - start };
			}
			await pause(250, signal);
		}
		throw new Error(
			`Drain timeout for ${provider}: unable to confirm financial/Outbox completion within ${String(config.drainMs)}ms`,
		);
	};

	try {
		report.metadata = await metadata();
		const services: Record<string, string[]> = {};
		for (const name of [
			'nginx',
			'postgres',
			'localstack',
			'api-1',
			'api-2',
			'api-3',
			'consumer-1',
			'consumer-2',
			'publisher-1',
			'publisher-2',
		]) {
			const addresses = await lookup(name, { all: true, family: 4 });
			assert(
				addresses.length > 0 &&
					addresses.every(({ address }) =>
						/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(
							address,
						),
					),
				`Non-local demo DNS for ${name}`,
			);
			services[name] = addresses.map(({ address }) => address);
			if (name.startsWith('api-'))
				for (const { address } of addresses)
					expectedUpstreams.add(`${address}:3000`);
		}
		assert(expectedUpstreams.size === 3, 'Three API addresses required');
		report.metadata.services = services;
		const ready = new Set<string>();
		for (let i = 0; i < 12 && ready.size < 3; i++) {
			checkSignal();
			const response = await http('/health/ready');
			assert(
				response.status === 200 &&
					expectedUpstreams.has(response.upstream ?? ''),
				'Demo readiness failed',
			);
			ready.add(response.upstream ?? '');
		}
		assert(ready.size === 3, 'Readiness must reach all three APIs');
		report.metadata.postgres =
			await observer.sql`select version(), current_setting('default_transaction_read_only') as observer_read_only`;
		console.log(
			`Distributed Wagering Processor — Load Test\nRun: ${runId}\nProfile: ${config.profile}`,
		);

		for (const [
			name,
			concurrency,
			walletCount,
			asynchronous,
			idempotent,
		] of [
			[
				'independent-wallets',
				config.concurrency,
				config.wallets,
				false,
				false,
			],
			[
				'hot-wallet-half',
				Math.max(1, Math.floor(config.concurrency / 2)),
				1,
				false,
				false,
			],
			['hot-wallet', config.concurrency, 1, false, false],
			['idempotency', config.concurrency, 1, false, true],
			['sqs-outbox', config.concurrency, config.wallets, true, false],
		] as const) {
			checkSignal();
			const scenario: Record<string, unknown> = {
				name,
				concurrency,
				wallets: walletCount,
				phase: 'preparation',
				reconciliation: 'NOT VERIFIED',
				startedAt: new Date().toISOString(),
			};
			report.scenarios.push(scenario);
			console.log(
				`\nScenario: ${name} (concurrency ${String(concurrency)})`,
			);
			const wallets = await createWallets(walletCount);
			scenario.walletIds = wallets.map(wallet => wallet.id);
			scenario.initialBalancePerWallet = initial;
			const provider = `${runId}-${name}`;
			scenario.provider = provider;
			const warmProvider = `${provider}-warmup`;
			const samples: HttpSample[] = [];
			const activeWalletIds = new Set<string>();
			const points: Sample[] = [];
			const queueSamples: {
				elapsedMs: number;
				depths: Record<string, number>;
			}[] = [];
			const pendingConfirmations = new Map<string, number>();
			const confirmationLatencies: number[] = [];
			const observeConfirmations = async (): Promise<void> => {
				if (!asynchronous || pendingConfirmations.size === 0) return;
				const ids = [...pendingConfirmations.keys()].slice(0, 1000);
				const confirmed = await observer.confirmedIds(provider, ids);
				const at = performance.now();
				for (const id of confirmed) {
					const submittedAt = pendingConfirmations.get(id);
					assert(submittedAt !== undefined);
					confirmationLatencies.push(at - submittedAt);
					pendingConfirmations.delete(id);
				}
			};
			if (asynchronous) {
				const depths = await queueDepth();
				scenario.queueBeforeWarmup = depths;
				baselineDlq = Object.entries(depths)
					.filter(([key]) => key.startsWith('dlq.'))
					.reduce((sum, [, value]) => sum + value, 0);
			}
			const chooseWallet = (sequence: number, worker: number): Wallet => {
				// Exclusive partitions avoid accidental financial lock contention in A.
				const partition = wallets.filter(
					(_, i) =>
						i % concurrency ===
						worker % Math.min(concurrency, wallets.length),
				);
				const selected =
					partition[
						Math.floor(sequence / concurrency) % partition.length
					];
				assert(selected !== undefined, 'No wallet for producer');
				return selected;
			};
			let warmCount = 0;
			scenario.phase = 'warm-up';
			if (config.warmupMs > 0) {
				const result = await produce(
					{
						concurrency,
						durationMs: config.warmupMs,
						maxOperations: config.maxOperations,
						signal,
						...(asynchronous ? { rate: config.sqsRate } : {}),
					},
					async (sequence, worker) => {
						const body = wager(
							chooseWallet(sequence, worker),
							warmProvider,
							idempotent ? 'replay' : String(sequence),
						);
						const response = await (asynchronous
							? send(body)
							: submit(body));
						assert(
							response.category === 'processed',
							`Warm-up ${response.category}`,
						);
						warmCount++;
					},
				);
				scenario.warmup = { ...result, requests: warmCount };
				await drain(
					warmProvider,
					idempotent ? 1 : warmCount,
					asynchronous,
				);
			}
			checkSignal();
			const firstWallet = wallets[0];
			assert(firstWallet !== undefined);
			let historical: string | undefined;
			if (idempotent) {
				const body = wager(firstWallet, provider, 'replay');
				const race = await Promise.all(
					Array.from({ length: concurrency }, () => submit(body)),
				);
				assert(
					race.every(response => response.category === 'processed'),
					'Concurrent identity race failed',
				);
				assert(
					race.filter(
						response =>
							object(response.body).idempotentReplay === false,
					).length === 1,
					'Exactly one first execution required',
				);
				historical = JSON.stringify({
					...object(race[0]?.body),
					idempotentReplay: true,
				});
				assert(
					race.every(
						response =>
							JSON.stringify({
								...object(response.body),
								idempotentReplay: true,
							}) === historical,
					),
					'Race replay result differs',
				);
				scenario.initialRace = {
					requests: race.length,
					httpLatencyMs: percentiles(
						race.map(item => item.latencyMs),
					),
					upstreams: [...new Set(race.map(item => item.upstream))],
				};
				const changed = await submit(
					wager(firstWallet, `${provider}-later`, 'later-bet'),
				);
				assert(
					changed.category === 'processed',
					'Historical replay balance preparation failed',
				);
				await drain(provider, 1, false);
				await drain(`${provider}-later`, 1, false);
			}
			scenario.phase = 'measurement';
			scenario.measurementStartedAt = new Date().toISOString();
			const first = await observer.point(provider);
			const start = performance.now();
			points.push({ ...first, elapsedMs: 0 });
			if (asynchronous)
				queueSamples.push({ elapsedMs: 0, depths: await queueDepth() });
			let monitoring = true;
			const stopped = (): boolean => !monitoring || signal.aborted;
			let monitorError: unknown;
			const monitor = (async (): Promise<void> => {
				try {
					while (!stopped()) {
						await pause(250, signal);
						if (stopped()) break;
						points.push({
							...(await observer.point(provider)),
							elapsedMs: performance.now() - start,
						});
						await observeConfirmations();
						if (
							asynchronous &&
							performance.now() -
								start -
								(queueSamples.at(-1)?.elapsedMs ?? 0) >=
								1000
						)
							queueSamples.push({
								elapsedMs: performance.now() - start,
								depths: await queueDepth(),
							});
					}
				} catch (error) {
					monitorError = error;
				}
			})();
			const phaseStart = performance.now();
			let phase;
			try {
				phase = await produce(
					{
						concurrency,
						durationMs: config.durationMs,
						maxOperations: config.maxOperations,
						signal,
						...(asynchronous ? { rate: config.sqsRate } : {}),
					},
					async (sequence, worker) => {
						const body = wager(
							chooseWallet(sequence, worker),
							provider,
							idempotent ? 'replay' : String(sequence),
						);
						activeWalletIds.add(body.walletId);
						if (asynchronous)
							pendingConfirmations.set(
								body.externalTransactionId,
								performance.now(),
							);
						const response = await (asynchronous
							? send(body)
							: submit(body));
						samples.push({
							result: response,
							elapsedMs: performance.now() - phaseStart,
						});
						if (idempotent && response.category === 'processed')
							assertInvariant(
								JSON.stringify(response.body) === historical,
								'Replay must preserve historical result after balance changes',
							);
					},
				);
			} finally {
				monitoring = false;
				await monitor;
				scenario.samples = samples;
				scenario.observations = points;
				scenario.queueSamples = queueSamples;
			}
			if (monitorError !== undefined)
				throw monitorError instanceof Error
					? monitorError
					: new Error('Observation failed');
			for (const sample of samples)
				sample.elapsedMs -= phase.startedAt - phaseStart;
			scenario.generationStoppedAt = new Date().toISOString();
			await observeConfirmations();
			const atStop = await observer.point(provider);
			const observationWindowMs = performance.now() - start;
			points.push({ ...atStop, elapsedMs: observationWindowMs });
			const counts: Record<string, number> = {};
			const upstreams: Record<string, number> = {};
			for (const { result } of samples) {
				counts[result.category] = (counts[result.category] ?? 0) + 1;
				if (result.upstream !== null)
					upstreams[result.upstream] =
						(upstreams[result.upstream] ?? 0) + 1;
			}
			const completed = samples.filter(
				item => item.result.category === 'processed',
			);
			const technicalErrors = samples.filter(
				item =>
					!['processed', 'business'].includes(item.result.category),
			).length;
			Object.assign(scenario, {
				phase: 'drain',
				submitted: samples.length,
				completed: completed.length,
				completedWithinWindow: completed.filter(
					item => item.elapsedMs <= phase.windowMs,
				).length,
				completedAfterWindow: completed.filter(
					item => item.elapsedMs > phase.windowMs,
				).length,
				measurementWindowMs: phase.windowMs,
				generationElapsedMs: phase.elapsedMs,
				throughputOpsPerSecond: throughput(
					completed.map(item => item.elapsedMs),
					phase.windowMs,
				),
				httpLatencyMs: asynchronous
					? null
					: percentiles(samples.map(item => item.result.latencyMs)),
				sqsSendLatencyMs: asynchronous
					? percentiles(samples.map(item => item.result.latencyMs))
					: null,
				categories: counts,
				technicalErrorRate:
					samples.length === 0
						? null
						: technicalErrors / samples.length,
				businessRejections: counts.business ?? 0,
				upstreams,
				activeWallets: activeWalletIds.size,
				sqlConflicts: null,
				sqlConflictsReason:
					'SQLSTATE is sanitized by HTTP; see databaseDeadlocksDelta and sampled waits',
			});
			if (technicalErrors > 0 || (counts.business ?? 0) > 0)
				report.errors.push(
					`${name}: ${String(technicalErrors)} technical/validation/timeout failures; ${String(counts.business ?? 0)} unexpected business rejections`,
				);
			if (!asynchronous && Object.keys(upstreams).length !== 3)
				report.errors.push(
					`${name}: measurement did not reach all three APIs`,
				);
			checkSignal();
			const uniqueExpected = idempotent ? 1 : samples.length;
			const drainStart = performance.now();
			const drained = await drain(
				provider,
				uniqueExpected,
				asynchronous,
				async point => {
					points.push({
						...point,
						elapsedMs: performance.now() - start,
					});
					await observeConfirmations();
				},
			);
			while (pendingConfirmations.size > 0) {
				const before = pendingConfirmations.size;
				await observeConfirmations();
				assert(
					pendingConfirmations.size < before,
					'Unable to observe all SQS financial confirmations',
				);
			}
			drained.drainMs = performance.now() - drainStart;
			const last = drained.point;
			Object.assign(scenario, {
				drainMs: drained.drainMs,
				final: last,
				databaseDeadlocksDelta:
					last.statsReset === first.statsReset
						? last.deadlocks - first.deadlocks
						: null,
				peakLockWaiters: Math.max(
					...points.map(point => point.lockWaiters),
				),
				peakWalletLockWaiters: Math.max(
					...points.map(point => point.walletLockWaiters),
				),
				lockWaitSamples: points.filter(
					point => point.walletLockWaiters > 0,
				).length,
				backlog: {
					start: first.pending,
					peak: Math.max(...points.map(point => point.pending)),
					end: last.pending,
					pendingCommands: uniqueExpected - last.confirmed,
				},
				publicationLagMs: await observer.publication(provider),
				publicationRetries: last.publicationRetries,
				inboxExtraCommittedAttempts: last.inboxExtraAttempts,
				observedClaimOwners: [
					...new Set(points.flatMap(point => point.claimOwners)),
				],
				observedDatabaseClients: [
					...new Set(points.flatMap(point => point.clients)),
				],
			});
			if (asynchronous) {
				queueSamples.push({
					elapsedMs: performance.now() - start,
					depths: await queueDepth(),
				});
				const peak: Record<string, number> = {};
				for (const item of queueSamples)
					for (const [key, value] of Object.entries(item.depths))
						peak[key] = Math.max(peak[key] ?? 0, value);
				Object.assign(scenario, {
					financialConfirmationObservedMs: percentiles(
						confirmationLatencies,
					),
					asyncProcessingMs: null,
					asyncProcessingReason:
						'Application timestamps share the same value; execution interval unavailable.',
					brokerDrain:
						'Two consecutive approximate empty-command samples, 250ms apart; DLQ count unchanged from baseline. Requires exclusive demo workload.',
					observationWindowMs,
					confirmedAtGenerationStop: atStop.confirmed,
					publishedAtGenerationStop: atStop.published,
					financialOpsPerSecondDuringGeneration:
						(atStop.confirmed * 1000) / observationWindowMs,
					eventsPerSecondDuringGeneration:
						(atStop.published * 1000) / observationWindowMs,
					financialOpsPerSecondIncludingDrain:
						(last.confirmed * 1000) / (performance.now() - start),
					queueBacklog: {
						start: queueSamples[0]?.depths,
						peak,
						end: queueSamples.at(-1)?.depths,
					},
				});
			}
			scenario.phase = 'reconciliation';
			const rows = await observer.reconcile(
				wallets.map(wallet => wallet.id),
				initial,
			);
			const expectedBets =
				(config.warmupMs === 0 ? 0 : idempotent ? 1 : warmCount) +
				(idempotent ? 2 : samples.length);
			assertInvariant(
				rows.reduce((sum, row) => sum + row.bets, 0) === expectedBets,
				'All submitted operations must have exactly one financial effect (replays excluded)',
			);
			scenario.financial = rows;
			scenario.reconciliation = 'PASS';
			scenario.phase = 'complete';
			scenario.finishedAt = new Date().toISOString();
			reconciled++;
			console.log(
				`Requests: ${String(samples.length)}; completed: ${String(completed.length)}; throughput: ${Number(scenario.throughputOpsPerSecond).toFixed(2)} ${asynchronous ? 'SQS sends' : 'HTTP ops'}/s\nLatency ms: ${JSON.stringify(asynchronous ? scenario.sqsSendLatencyMs : scenario.httpLatencyMs)}\nTechnical error rate: ${((technicalErrors * 100) / Math.max(samples.length, 1)).toFixed(2)}%; business rejections: ${String(counts.business ?? 0)}\nOutbox publication interval ms: ${JSON.stringify(scenario.publicationLagMs)}\nDrain: ${drained.drainMs.toFixed(2)} ms; pending: ${String(last.pending)}\nReconciliation: PASS`,
			);
			console.log(
				`Active wallets: ${String(activeWalletIds.size)}; SQL conflicts: unavailable; database deadlocks delta: ${String(scenario.databaseDeadlocksDelta)}; peak sampled wallet lock waiters: ${String(scenario.peakWalletLockWaiters)}`,
			);
			if (walletCount === 1)
				console.log(
					`Initial balance: ${initial}; final balance: ${rows[0]?.balance ?? 'unknown'} BRL; confirmed debits including preparation: ${String(rows[0]?.debits)}`,
				);
			if (asynchronous)
				console.log(
					`Financial operations confirmed: ${String(last.confirmed)}; events published: ${String(last.published)}\nObserved rates during generation: ${Number(scenario.financialOpsPerSecondDuringGeneration).toFixed(2)} financial ops/s; ${Number(scenario.eventsPerSecondDuringGeneration).toFixed(2)} events/s\nPending commands after drain: ${String(uniqueExpected - last.confirmed)}`,
				);
			await save();
		}
		report.status = verdict(
			signal.aborted,
			report.errors,
			reconciled === 5,
		);
	} catch (error) {
		report.errors.push(String(error));
		report.status =
			signal.aborted || /timeout|abort/i.test(String(error))
				? 'INCOMPLETE'
				: 'FAIL';
		console.error(String(error));
	} finally {
		sqs.destroy();
		await finalize(
			report,
			signal,
			async () => {
				await observer.sql.close({ timeout: 5 });
				report.metadata.finishedAt = new Date().toISOString();
			},
			save,
		);
		cleanup();
		console.log(
			`\nRESULT: ${report.status}\nReports: load-results/${runId}.{json,md}`,
		);
	}
	return report.status === 'PASS' ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
