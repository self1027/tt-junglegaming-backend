import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../src/bootstrap/api.module.js';
import { createApi } from '../src/bootstrap/create-api.js';

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
	});
});
