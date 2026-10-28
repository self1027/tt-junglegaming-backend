import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { ApiModule } from '../src/bootstrap/api.module.js';
import { createApi } from '../src/bootstrap/create-api.js';
import { startPostgres } from './support/postgres.js';
import type { TestPostgres } from './support/postgres.js';

let postgres: TestPostgres | undefined;
const previousEnv = { ...process.env };

beforeAll(async () => {
	postgres = await startPostgres();
	Object.assign(process.env, postgres.env);
}, 90_000);

afterAll(async () => {
	process.env = previousEnv;
	await postgres?.close();
}, 30_000);

describe('API bootstrap', () => {
	test('initializes the Nest module', async () => {
		const module = await Test.createTestingModule({
			imports: [ApiModule],
		}).compile();
		try {
			await module.init();
			expect(module.get(ApiModule)).toBeInstanceOf(ApiModule);
		} finally {
			await module.close();
		}
	});

	test('serves only HTTP liveness', async () => {
		const app = await createApi();
		const orm = app.get(MikroORM);
		try {
			await app.listen(0, '127.0.0.1');
			const url = await app.getUrl();
			const response = await fetch(`${url}/health/live`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: 'ok' });
			expect((await fetch(`${url}/`)).status).toBe(404);
		} finally {
			await app.close();
		}
		expect(await orm.isConnected()).toBe(false);
	});
});
