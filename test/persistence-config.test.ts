import { expect, test } from 'bun:test';
import { persistenceConfig } from '../src/platform/persistence/config.js';
import { ExactNumericType } from '../src/platform/persistence/exact-numeric.type.js';

const env = {
	POSTGRES_HOST: 'localhost',
	POSTGRES_PORT: '5432',
	POSTGRES_DB: 'test',
	POSTGRES_USER: 'test',
	POSTGRES_PASSWORD: 'test',
};

test('validates environment before opening a connection', () => {
	expect(persistenceConfig(env).pool).toMatchObject({ min: 0, max: 10 });
	for (const key of Object.keys(env)) {
		expect(() => persistenceConfig({ ...env, [key]: '' })).toThrow(
			`${key} is required`,
		);
	}
	for (const value of ['0', '-1', '65536', 'NaN', '1.5', '1e3']) {
		expect(() =>
			persistenceConfig({ ...env, POSTGRES_PORT: value }),
		).toThrow('POSTGRES_PORT');
	}
	expect(() => persistenceConfig({ ...env, POSTGRES_POOL_MAX: '0' })).toThrow(
		'POSTGRES_POOL_MAX',
	);
});

test('converts exact NUMERIC strings without accepting numbers or lossy representations', () => {
	const type = new ExactNumericType();
	expect(
		type.convertToDatabaseValue('123456789012345678901234567890.12'),
	).toBe('123456789012345678901234567890.12');
	expect(
		type.compareValues(
			'12345678901234567890.12',
			'12345678901234567890.13',
		),
	).toBe(false);
	for (const value of [
		1,
		'1',
		'1.001',
		'NaN',
		'Infinity',
		'1e2',
		'-1.00',
		'',
	]) {
		expect(() => type.convertToDatabaseValue(value)).toThrow(
			'NUMERIC money',
		);
	}
});
