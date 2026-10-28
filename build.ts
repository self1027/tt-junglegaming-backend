import { rm } from 'node:fs/promises';

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });
const result = Bun.spawnSync(
	[
		process.execPath,
		'node_modules/typescript/bin/tsc',
		'--project',
		'tsconfig.build.json',
	],
	{ stdout: 'inherit', stderr: 'inherit' },
);
process.exit(result.exitCode);
