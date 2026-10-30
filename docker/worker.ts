import { rmSync, writeFileSync } from 'node:fs';

// Observe existing startup diagnostics without adding a health listener to workers.
const roles: Record<string, string> = {
	consumer: 'consumer_ready',
	publisher: 'publisher_ready',
	'pending-worker': 'pending_ready',
};
const role = process.argv[2] ?? '';
const readyEvent = roles[role];
if (readyEvent === undefined) throw new Error('Unknown worker role');
const marker = '/tmp/dwp-worker-ready';
rmSync(marker, { force: true });
const child = Bun.spawn(['bun', `dist/main.${role}.js`], {
	stdout: 'pipe',
	stderr: 'inherit',
});
let stopping = false;
const stop = (signal: 'SIGTERM' | 'SIGINT'): void => {
	if (stopping) return;
	stopping = true;
	rmSync(marker, { force: true });
	child.kill(signal);
};
process.on('SIGTERM', () => {
	stop('SIGTERM');
});
process.on('SIGINT', () => {
	stop('SIGINT');
});
const output = async (): Promise<void> => {
	let buffer = '';
	for await (const chunk of child.stdout.pipeThrough(
		new TextDecoderStream(),
	)) {
		process.stdout.write(chunk);
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let data: unknown;
			try {
				data = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			if (
				!stopping &&
				typeof data === 'object' &&
				data !== null &&
				'event' in data &&
				data.event === readyEvent &&
				'pid' in data &&
				data.pid === child.pid
			) {
				writeFileSync(marker, String(child.pid));
			}
		}
	}
};
try {
	const [code] = await Promise.all([child.exited, output()]);
	process.exitCode = code;
} finally {
	rmSync(marker, { force: true });
	if (child.exitCode === null) child.kill('SIGTERM');
}
