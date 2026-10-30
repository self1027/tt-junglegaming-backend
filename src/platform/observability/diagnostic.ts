export interface MetricSample {
	readonly name: string;
	readonly kind: 'counter' | 'gauge' | 'observation';
	readonly value: number;
	readonly labels: Readonly<Record<string, string>>;
}

export function metricSamples(record: Record<string, unknown>): MetricSample[] {
	const samples: MetricSample[] = [];
	const add = (
		name: string,
		kind: MetricSample['kind'],
		value: unknown,
		labels: Record<string, string> = {},
	): void => {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
			samples.push({ name, kind, value, labels });
	};
	const source = record.event === 'http_wager_completed' ? 'http' : 'sqs';
	if (record.event === 'http_wager_failed')
		add('processing_duration_ms', 'observation', record.latencyMs, {
			source: 'http',
		});
	if (
		record.event === 'http_wager_completed' ||
		record.event === 'committed'
	) {
		const duplicate =
			record.status === 'DUPLICATE' || record.idempotentReplay === true;
		if (duplicate) add('duplicates_total', 'counter', 1, { source });
		else if (
			typeof record.status === 'string' &&
			[
				'PROCESSED',
				'REJECTED',
				'PENDING',
				'PENDING_REFERENCE',
				'FAILED',
			].includes(record.status)
		)
			add('wagering_results_total', 'counter', 1, {
				source,
				status: record.status,
			});
		add('processing_duration_ms', 'observation', record.latencyMs, {
			source,
		});
	}
	if (record.event === 'pending_attempt') {
		if (record.outcome === 'PROCESSED' || record.outcome === 'REJECTED')
			add('wagering_results_total', 'counter', 1, {
				source: 'pending',
				status: record.outcome,
			});
		else if (
			['WAITING', 'SQL_UNCERTAIN', 'RETRY_UNCERTAIN'].includes(
				String(record.outcome),
			)
		)
			add('retries_total', 'counter', 1, { source: 'pending' });
		add('processing_duration_ms', 'observation', record.latencyMs, {
			source: 'pending',
		});
	}
	if (record.event === 'message_retry' && record.delaySeconds !== 0)
		add('retries_total', 'counter', 1, { source: 'sqs' });
	if (record.event === 'publication_retry')
		add('retries_total', 'counter', 1, { source: 'publisher' });
	if (record.event === 'database_conflict')
		add('lock_conflicts_total', 'counter', 1);
	if (record.event === 'publisher_diagnostics')
		add('outbox_lag_ms', 'gauge', record.lagMs);
	if (record.event === 'sqs_diagnostics')
		add('dlq_visible_messages', 'gauge', record.visible);
	if (record.event === 'wallet_reconciliation_divergence')
		add('reconciliation_divergences_total', 'counter', 1);
	return samples;
}

export function diagnostic(record: Record<string, unknown>): void {
	try {
		console.log(
			JSON.stringify({
				pid: process.pid,
				...record,
				metrics: metricSamples(record),
			}),
		);
	} catch {
		// Diagnostics must not turn a confirmed commit into a failed business response.
	}
}

export function diagnosticIdentity(value: unknown): Record<string, string> {
	const fields: Record<string, string> = {};
	if (typeof value !== 'object' || value === null) return fields;
	for (const key of [
		'providerId',
		'walletId',
		'transactionId',
		'messageId',
		'correlationId',
	]) {
		if (key in value) {
			const field: unknown = Reflect.get(value, key);
			if (typeof field === 'string') fields[key] = field;
		}
	}
	return fields;
}
