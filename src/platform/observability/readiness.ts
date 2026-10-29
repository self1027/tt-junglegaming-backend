export const READINESS = Symbol('Readiness');

export interface ReadinessResult {
	readonly status: 'not_ready';
	readonly checks: {
		readonly postgres: 'up' | 'down';
		readonly sqs: 'not_configured';
	};
}

export interface Readiness {
	check(): Promise<ReadinessResult>;
}
