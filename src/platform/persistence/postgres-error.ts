export function postgresError(error: unknown): {
	code?: string;
	constraint?: string;
} {
	if (typeof error !== 'object' || error === null) return {};
	const code =
		'code' in error && typeof error.code === 'string'
			? error.code
			: undefined;
	const constraint =
		'constraint' in error && typeof error.constraint === 'string'
			? error.constraint
			: undefined;
	if (code !== undefined)
		return { code, ...(constraint === undefined ? {} : { constraint }) };
	return 'cause' in error && error.cause !== error
		? postgresError(error.cause)
		: {};
}

export function isPostgresPoolTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === 'timeout exceeded when trying to connect' ||
			error.message === 'Connection terminated due to connection timeout')
	);
}
