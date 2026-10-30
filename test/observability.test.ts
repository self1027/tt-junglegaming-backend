import { expect, spyOn, test } from 'bun:test';
import {
	diagnostic,
	diagnosticIdentity,
	metricSamples,
} from '../src/platform/observability/diagnostic.js';

test('metrics distinguish new results, business replay and Inbox duplicates without ID labels', () => {
	for (const event of ['http_wager_completed', 'committed']) {
		const source = event === 'committed' ? 'sqs' : 'http';
		const result = {
			event,
			status: 'PROCESSED',
			latencyMs: 4,
			walletId: 'wallet',
			amount: 'secret',
		};
		expect(metricSamples(result)).toEqual([
			{
				name: 'wagering_results_total',
				kind: 'counter',
				value: 1,
				labels: { source, status: 'PROCESSED' },
			},
			{
				name: 'processing_duration_ms',
				kind: 'observation',
				value: 4,
				labels: { source },
			},
		]);
		expect(
			metricSamples({ ...result, idempotentReplay: true })[0]?.name,
		).toBe('duplicates_total');
	}
	expect(
		metricSamples({ event: 'committed', status: 'DUPLICATE' })[0]?.name,
	).toBe('duplicates_total');
	expect(
		diagnosticIdentity({
			providerId: 'p',
			transactionId: 't',
			money: 'secret',
			idempotencyKey: 'secret',
			playerId: 'secret',
		}),
	).toEqual({ providerId: 'p', transactionId: 't' });
});

test('metrics cover retries, DLQ, lock conflicts, outbox lag, pending resolution and reconciliation', () => {
	for (const [event, name, fields] of [
		['message_retry', 'retries_total', { delaySeconds: 2 }],
		['publication_retry', 'retries_total', {}],
		['database_conflict', 'lock_conflicts_total', {}],
		['publisher_diagnostics', 'outbox_lag_ms', { lagMs: 123 }],
		['sqs_diagnostics', 'dlq_visible_messages', { visible: 2 }],
		['pending_attempt', 'wagering_results_total', { outcome: 'REJECTED' }],
		[
			'wallet_reconciliation_divergence',
			'reconciliation_divergences_total',
			{},
		],
	] as const)
		expect(metricSamples({ event, ...fields })[0]?.name).toBe(name);
	expect(metricSamples({ event: 'message_retry', delaySeconds: 0 })).toEqual(
		[],
	);
	expect(metricSamples({ event: 'sqs_diagnostics', visible: NaN })).toEqual(
		[],
	);
	expect(
		metricSamples({
			event: 'publisher_diagnostics',
			dependencies: 'UNAVAILABLE',
		}),
	).toEqual([]);
});

test('a diagnostic output failure cannot turn a confirmed result into an application failure', () => {
	const log = spyOn(console, 'log').mockImplementation(() => {
		throw new Error('sink unavailable');
	});
	try {
		expect(() => {
			diagnostic({ event: 'committed', status: 'PROCESSED' });
		}).not.toThrow();
	} finally {
		log.mockRestore();
	}
});
