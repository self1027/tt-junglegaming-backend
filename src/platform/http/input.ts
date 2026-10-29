import { BadRequestException, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext, PipeTransform } from '@nestjs/common';

export function objectInput(
	value: unknown,
	fields: readonly string[],
): Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !fields.includes(key))
	)
		throw new BadRequestException('Invalid request');
	return value as Record<string, unknown>;
}

export function textInput(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.trim() === '' ||
		value.includes('\0') ||
		/[\uD800-\uDFFF]/u.test(value)
	)
		throw new BadRequestException('Invalid text');
	return value;
}

export function uuidInput(value: unknown): string {
	const id = textInput(value);
	if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
		throw new BadRequestException('Invalid identifier');
	return id.toLowerCase();
}

export function moneyInput(value: unknown): {
	amount: string;
	currency: string;
} {
	const data = objectInput(value, ['amount', 'currency']);
	return {
		amount: textInput(data.amount),
		currency: textInput(data.currency),
	};
}

export class UuidPipe implements PipeTransform<unknown, string> {
	transform(value: unknown): string {
		return uuidInput(value);
	}
}

export class IdentityPipe implements PipeTransform<unknown, string> {
	transform(value: unknown): string {
		return textInput(value);
	}
}

export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
	transform(value: unknown): string {
		const key = textInput(value);
		if (/[\s,\p{Cc}]/u.test(key))
			throw new BadRequestException('Invalid Idempotency-Key');
		return key;
	}
}

export class LedgerQueryPipe implements PipeTransform<
	unknown,
	{ cursor?: string | undefined; limit: number }
> {
	transform(value: unknown): { cursor?: string | undefined; limit: number } {
		const query = objectInput(value, ['cursor', 'limit']);
		const limit = query.limit === undefined ? '50' : textInput(query.limit);
		if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100)
			throw new BadRequestException('Invalid limit');
		return {
			cursor:
				query.cursor === undefined
					? undefined
					: textInput(query.cursor),
			limit: Number(limit),
		};
	}
}

export const IdempotencyKey = createParamDecorator(
	(_data: unknown, context: ExecutionContext): string =>
		new IdempotencyKeyPipe().transform(
			context
				.switchToHttp()
				.getRequest<{ headers: Record<string, unknown> }>().headers[
				'idempotency-key'
			],
		),
);
