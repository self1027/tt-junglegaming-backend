import { MikroORM } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/platform/persistence/config.js';

export async function command(
	args: string[],
	env = process.env,
): Promise<string> {
	const child = Bun.spawn(args, { env, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(
			`${args.slice(0, 2).join(' ')} failed (${String(code)}): ${stderr}${stdout}`,
		);
	}
	return stdout.trim();
}

export interface TestPostgres {
	env: NodeJS.ProcessEnv;
	config: Options;
	close: () => Promise<void>;
}

export async function startPostgres(): Promise<TestPostgres> {
	const project = `dwp-test-${crypto.randomUUID()}`;
	const env = {
		...process.env,
		POSTGRES_HOST: '127.0.0.1',
		POSTGRES_PORT: '0',
		POSTGRES_DB: 'wagering_test',
		POSTGRES_USER: 'wagering_test',
		POSTGRES_PASSWORD: crypto.randomUUID(),
		POSTGRES_POOL_MAX: '5',
	};
	const compose = [
		'docker',
		'compose',
		'--project-name',
		project,
		'--env-file',
		'.env.example',
	];
	const close = async (): Promise<void> => {
		await command(
			[...compose, 'down', '--volumes', '--remove-orphans'],
			env,
		);
	};
	try {
		await command(
			[...compose, 'up', '-d', '--wait', '--wait-timeout', '60'],
			env,
		);
		const address = await command(
			[...compose, 'port', 'postgres', '5432'],
			env,
		);
		const port = address.split(':').at(-1);
		if (port === undefined || !/^\d+$/.test(port)) {
			throw new Error('Cannot resolve test PostgreSQL port');
		}
		env.POSTGRES_PORT = port;
		return { env, config: persistenceConfig(env), close };
	} catch (error) {
		await close();
		throw error;
	}
}

export async function testOrm(postgres: TestPostgres): Promise<MikroORM> {
	return MikroORM.init(postgres.config);
}
