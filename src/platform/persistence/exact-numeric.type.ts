import { Type } from '@mikro-orm/core';

// Keep NUMERIC conversion and dirty checking entirely in decimal strings.
export class ExactNumericType extends Type<string, string> {
	override convertToDatabaseValue(value: unknown): string {
		if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) {
			throw new Error(
				'NUMERIC money must be a non-negative decimal string with scale 2',
			);
		}
		return value;
	}

	override getColumnType(): string {
		return 'numeric';
	}

	override compareAsType(): string {
		return 'string';
	}

	override compareValues(a: string, b: string): boolean {
		return a === b;
	}
}
