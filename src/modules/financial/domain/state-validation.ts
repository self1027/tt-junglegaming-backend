export function isUuid(value: string): boolean {
	return (
		typeof value === 'string' &&
		value.trim() === value &&
		/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
	);
}

export function isValidDate(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}
