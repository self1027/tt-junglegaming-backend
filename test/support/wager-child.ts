import type { ProcessWagerCommand } from '../../src/modules/wagering/public/process-wager.js';

export function wagerChild(
	env: NodeJS.ProcessEnv,
	input: ProcessWagerCommand,
	mode = 'normal',
	script = 'test/support/wager-process.ts',
): {
	pid: number;
	signal: () => Promise<void>;
	next: () => Promise<string>;
	kill: () => Promise<void>;
	close: () => Promise<void>;
} {
	const child = Bun.spawn([process.execPath, script, mode], {
		env: { ...env, WAGER_COMMAND: JSON.stringify(input) },
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	const stderr = new Response(child.stderr).text();
	let buffer = '';
	let finished = false;
	let killed = false;
	return {
		pid: child.pid,
		async signal(): Promise<void> {
			await child.stdin.write('\n');
			await child.stdin.flush();
		},
		async next(): Promise<string> {
			while (!buffer.includes('\n')) {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					const chunk = await Promise.race([
						reader.read(),
						new Promise<never>((_resolve, reject) => {
							timeout = setTimeout(() => {
								reject(
									new Error(
										'Timed out waiting for Bun child signal',
									),
								);
							}, 10_000);
						}),
					]);
					if (chunk.done)
						throw new Error(
							`Child exited before signal: ${await stderr}`,
						);
					buffer += decoder.decode(chunk.value, { stream: true });
				} finally {
					clearTimeout(timeout);
				}
			}
			const end = buffer.indexOf('\n');
			const message: unknown = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (
				typeof message !== 'object' ||
				message === null ||
				!('pid' in message) ||
				message.pid !== child.pid ||
				!('result' in message) ||
				typeof message.result !== 'string'
			)
				throw new Error('Invalid Bun child signal');
			console.log(JSON.stringify(message));
			finished = ![
				'ready',
				'before-commit',
				'committed-before-response',
				'claimed',
			].includes(message.result);
			return message.result;
		},
		async kill(): Promise<void> {
			killed = true;
			child.kill();
			await child.exited;
		},
		async close(): Promise<void> {
			if (!finished && !killed) child.kill();
			const code = await child.exited;
			reader.releaseLock();
			const errors = await stderr;
			if (finished && !killed && code !== 0)
				throw new Error(`Child failed: ${errors}`);
		},
	};
}
