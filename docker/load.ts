import { mkdir } from 'node:fs/promises';
import { cpus, totalmem, freemem, platform, release } from 'node:os';
import { configuration } from './load/core.js';

async function capture(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(`${command[0] ?? 'Command'} failed: ${stderr}`);
	return stdout.trim();
}

async function launch(): Promise<number> {
	const config = configuration(process.env);
	if (process.argv.length > 2)
		throw new Error(
			'Use validated LOAD_* environment variables; flags are not supported',
		);
	await mkdir('load-results', { recursive: true });
	const compose = ['docker', 'compose', '-f', 'compose.demo.yaml'];
	const ids = (await capture([...compose, 'ps', '-q']))
		.split(/\s+/)
		.filter(Boolean);
	if (ids.length === 0)
		throw new Error(
			'Start the demo first: docker compose -f compose.demo.yaml up -d --build --wait',
		);
	const containers = await capture([
		'docker',
		'inspect',
		'--format',
		'{"name":{{json .Name}},"id":{{json .Id}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"pid":{{json .State.Pid}},"memoryLimit":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}}}',
		...ids,
	]);
	const metadata = JSON.stringify({
		os: `${platform()} ${release()}`,
		cpu: cpus()[0]?.model,
		logicalCPUs: cpus().length,
		memoryBytes: totalmem(),
		freeMemoryBytes: freemem(),
		bun: Bun.version,
		commit: await capture(['git', 'rev-parse', 'HEAD']),
		branch: await capture(['git', 'branch', '--show-current']),
		workingTree: await capture(['git', 'status', '--short']),
		docker: await capture([
			'docker',
			'version',
			'--format',
			'{{json .Server}}',
		]),
		daemonResources: await capture([
			'docker',
			'info',
			'--format',
			'{"cpus":{{json .NCPU}},"memoryBytes":{{json .MemTotal}}}',
		]),
		containers: containers
			.split('\n')
			.map(line => JSON.parse(line) as unknown),
	});
	const name = `dwp-load-${crypto.randomUUID()}`;
	const variables = {
		LOAD_PROFILE: config.profile,
		LOAD_DURATION_MS: config.durationMs,
		LOAD_WARMUP_MS: config.warmupMs,
		LOAD_CONCURRENCY: config.concurrency,
		LOAD_WALLETS: config.wallets,
		LOAD_MAX_OPERATIONS: config.maxOperations,
		LOAD_SQS_RATE: config.sqsRate,
		LOAD_TIMEOUT_MS: config.timeoutMs,
		LOAD_DRAIN_MS: config.drainMs,
		LOAD_HOST_METADATA: metadata,
	};
	const child = Bun.spawn(
		[
			...compose,
			'run',
			'--rm',
			'--name',
			name,
			...Object.entries(variables).flatMap(([key, value]) => [
				'-e',
				`${key}=${String(value)}`,
			]),
			'load',
		],
		{ stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
	);
	const forward = (signal: 'SIGINT' | 'SIGTERM'): void => {
		const stop = Bun.spawn(['docker', 'kill', `--signal=${signal}`, name], {
			stdout: 'ignore',
			stderr: 'inherit',
		});
		void stop.exited;
	};
	const interrupt = (): void => {
		forward('SIGINT');
	};
	const terminate = (): void => {
		forward('SIGTERM');
	};
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', terminate);
	try {
		return await child.exited;
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
	}
}

try {
	process.exitCode = await launch();
} catch (error) {
	console.error(String(error));
	process.exitCode = 1;
}
