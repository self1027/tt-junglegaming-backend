export const READINESS = Symbol('Readiness');

export interface ReadinessResult {
	readonly status: 'ready' | 'not_ready';
	readonly checks: {
		readonly postgres: 'up' | 'down';
		readonly sqs: 'up' | 'down' | 'not_configured';
	};
}

export interface Readiness {
	check(): Promise<ReadinessResult>;
}

export async function readinessResponse(
	readiness: Readiness,
	response: { status(code: number): unknown },
): Promise<ReadinessResult> {
	const result = await readiness.check();
	response.status(result.status === 'ready' ? 200 : 503);
	return result;
}
