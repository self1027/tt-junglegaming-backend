import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { persistenceEntities } from './models.js';
import { Migration202610280001 } from './migrations/Migration202610280001.js';
import { Migration202610280002 } from './migrations/Migration202610280002.js';
import { Migration202610290001 } from './migrations/Migration202610290001.js';

function required(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key];
	if (value === undefined || value.trim() === '') {
		throw new Error(`${key} is required`);
	}
	return value;
}

function integer(value: string, key: string, max: number): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(
			`${key} must be a positive integer up to ${String(max)}`,
		);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
		throw new Error(
			`${key} must be a positive integer up to ${String(max)}`,
		);
	}
	return parsed;
}

export function persistenceConfig(
	env: NodeJS.ProcessEnv = process.env,
): Options {
	return defineConfig({
		entities: persistenceEntities,
		host: required(env, 'POSTGRES_HOST'),
		port: integer(required(env, 'POSTGRES_PORT'), 'POSTGRES_PORT', 65535),
		dbName: required(env, 'POSTGRES_DB'),
		user: required(env, 'POSTGRES_USER'),
		password: required(env, 'POSTGRES_PASSWORD'),
		driverOptions: { connectionTimeoutMillis: 5_000 },
		pool: {
			min: 0,
			max: integer(
				env.POSTGRES_POOL_MAX ?? '10',
				'POSTGRES_POOL_MAX',
				2147483647,
			),
			idleTimeoutMillis: 30_000,
		},
		ensureDatabase: false,
		allowGlobalContext: false,
		debug: false,
		extensions: [Migrator],
		migrations: {
			migrationsList: [
				Migration202610280001,
				Migration202610280002,
				Migration202610290001,
			],
			transactional: true,
			allOrNothing: true,
			disableForeignKeys: false,
			snapshot: false,
		},
	});
}
