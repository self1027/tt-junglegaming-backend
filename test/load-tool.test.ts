import { describe, expect, test } from 'bun:test';
import {
	configuration,
	classify,
	percentiles,
	throughput,
	assertInvariant,
	verdict,
	renderReport,
	request,
	produce,
	installShutdown,
} from '../docker/load/core.js';

describe('load tool trust boundaries', () => {
	test('accepts profiles and bounded overrides, rejects malformed or excessive work', () => {
		expect(configuration({}).profile).toBe('quick');
		expect(configuration({ LOAD_PROFILE: 'standard' }).durationMs).toBe(
			30000,
		);
		expect(configuration({ LOAD_CONCURRENCY: '3' }).concurrency).toBe(3);
		for (const env of [
			{ LOAD_PROFILE: 'large' },
			{ LOAD_CONCURRENCY: '0' },
			{ LOAD_CONCURRENCY: '1.5' },
			{ LOAD_CONCURRENCY: '101' },
			{ LOAD_DURATION_MS: 'Infinity' },
			{ LOAD_MAX_OPERATIONS: '100001' },
			{ LOAD_WALLETS: '2' },
			{ LOAD_SQS_RATE: '1001' },
			{ LOAD_TARGET: 'production' },
			{ API_BASE_URL: 'https://example.com' },
			{ SQS_ENDPOINT: 'https://sqs.us-east-1.amazonaws.com' },
			{ POSTGRES_HOST: 'example.com' },
		])
			expect(() => configuration(env)).toThrow();
	});

	test('nearest rank uses actual samples and reports an empty set as null', () => {
		expect(percentiles([])).toEqual({
			samples: 0,
			p50: null,
			p95: null,
			p99: null,
			max: null,
		});
		expect(percentiles([9, 1, 7, 3, 5])).toEqual({
			samples: 5,
			p50: 5,
			p95: 9,
			p99: 9,
			max: 9,
		});
		expect(
			percentiles(Array.from({ length: 100 }, (_, i) => i + 1)),
		).toEqual({ samples: 100, p50: 50, p95: 95, p99: 99, max: 100 });
		expect(() => percentiles([NaN])).toThrow();
	});

	test('throughput counts only completions in the measurement window', () => {
		expect(throughput([5, 20, 99, 105], 100)).toBe(30);
		expect(throughput([], 100)).toBe(0);
		expect(() => throughput([], 0)).toThrow();
	});

	test('distinguishes persisted business rejection, input errors and technical failures', () => {
		expect(
			classify(200, {
				status: 'PROCESSED',
				transactionId: 't',
				idempotentReplay: false,
				balance: { amount: '9.00', currency: 'BRL' },
			}),
		).toBe('processed');
		expect(
			classify(422, {
				status: 'REJECTED',
				transactionId: 't',
				failureCode: 'BET_INSUFFICIENT_BALANCE',
				idempotentReplay: false,
			}),
		).toBe('business');
		expect(classify(422, { code: 'INVALID_REQUEST' })).toBe('validation');
		expect(classify(400, { code: 'INVALID_REQUEST' })).toBe('validation');
		expect(classify(503, {})).toBe('infrastructure');
		expect(classify(409, {})).toBe('conflict');
		expect(classify(500, {})).toBe('technical');
		expect(classify(200, {})).toBe('validation');
		expect(classify(202, { status: 'PENDING_REFERENCE' })).toBe('pending');
	});

	test('financial violations are critical and cannot become PASS', () => {
		expect(() => {
			assertInvariant(false, 'ledger mismatch');
		}).toThrow('CRITICAL');
		expect(verdict(false, [], true)).toBe('PASS');
		expect(verdict(false, [], false)).toBe('INCOMPLETE');
		expect(verdict(true, [], true)).toBe('INCOMPLETE');
		expect(verdict(false, ['timeout'], true)).toBe('FAIL');
	});

	test('report keeps parameters, metadata, samples and incomplete status', () => {
		const report = {
			status: 'INCOMPLETE',
			runId: 'r',
			config: configuration({}),
			metadata: { commit: 'abc', bun: Bun.version },
			scenarios: [],
			errors: ['SIGTERM'],
		};
		const encoded = JSON.stringify(report);
		expect(JSON.parse(encoded)).toMatchObject({
			status: 'INCOMPLETE',
			metadata: { commit: 'abc' },
		});
		const md = renderReport(report);
		expect(md).toContain('INCOMPLETE');
		expect(md).toContain('SIGTERM');
		expect(md).toContain('abc');
		expect(md).not.toContain('RESULT: PASS');
	});
});

describe('load tool lifecycle', () => {
	test('worker failure stops scheduling and waits for other in-flight work', async () => {
		let settled = false;
		let calls = 0;
		try {
			await produce(
				{
					concurrency: 2,
					durationMs: 1000,
					maxOperations: 100,
					signal: new AbortController().signal,
				},
				async (_, worker) => {
					calls++;
					if (worker === 0) throw new Error('critical');
					await Bun.sleep(10);
					settled = true;
				},
			);
			throw new Error('Expected failure');
		} catch (error) {
			expect(String(error)).toContain('critical');
		}
		expect(settled).toBe(true);
		expect(calls).toBeLessThanOrEqual(2);
	});
	test('timeout is observed through body consumption and redirects are refused', async () => {
		const server = Bun.serve({
			port: 0,
			fetch: req => {
				if (new URL(req.url).pathname === '/redirect')
					return Response.redirect('http://example.com');
				return new Response(new ReadableStream());
			},
		});
		try {
			const slow = await request(
				`${server.url.href}slow`,
				{},
				30,
				new AbortController().signal,
			);
			expect(slow.category).toBe('timeout');
			const redirect = await request(
				`${server.url.href}redirect`,
				{},
				1000,
				new AbortController().signal,
			);
			expect(redirect.category).toBe('validation');
		} finally {
			await server.stop(true);
		}
	});

	test('backpressure bounds in-flight operations and caps submitted work', async () => {
		let active = 0;
		let peak = 0;
		let calls = 0;
		await produce(
			{
				concurrency: 3,
				durationMs: 1000,
				maxOperations: 11,
				signal: new AbortController().signal,
			},
			async () => {
				active++;
				peak = Math.max(peak, active);
				calls++;
				await Bun.sleep(1);
				active--;
			},
		);
		expect(calls).toBe(11);
		expect(peak).toBe(3);
	});

	test('abort stops new submissions and settles in-flight work', async () => {
		const controller = new AbortController();
		let calls = 0;
		await produce(
			{
				concurrency: 1,
				durationMs: 1000,
				maxOperations: 100,
				signal: controller.signal,
			},
			async () => {
				calls++;
				controller.abort();
				await Promise.resolve();
			},
		);
		expect(calls).toBe(1);
	});

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		test(`${signal} marks cancellation and removes listeners on cleanup`, () => {
			const before = process.listenerCount(signal);
			const controller = new AbortController();
			const cleanup = installShutdown(controller);
			try {
				process.emit(signal);
				expect(controller.signal.aborted).toBe(true);
				expect(String(controller.signal.reason)).toContain(signal);
			} finally {
				cleanup();
			}
			expect(process.listenerCount(signal)).toBe(before);
		});
	}
});
