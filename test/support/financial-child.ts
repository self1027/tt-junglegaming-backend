export function financialChild(
	env: NodeJS.ProcessEnv,
	walletId: string,
	mode: string,
): {
	pid: number;
	signal: () => Promise<void>;
	next: () => Promise<string>;
	close: () => Promise<void>;
	diagnostics: Record<string, unknown>[];
} {
	const child = Bun.spawn(
		[process.execPath, 'test/support/financial-process.ts', walletId, mode],
		{ env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
	);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	const stderr = new Response(child.stderr).text();
	let buffer = '';
	let finished = false;
	const diagnostics: Record<string, unknown>[] = [];
	return {
		diagnostics,
		pid: child.pid,
		async signal(): Promise<void> {
			await child.stdin.write('\n');
			await child.stdin.flush();
		},
		async next(): Promise<string> {
			for (;;) {
				while (!buffer.includes('\n')) {
					const chunk = await reader.read();
					if (chunk.done)
						throw new Error(
							`Child exited before signal: ${await stderr}`,
						);
					buffer += decoder.decode(chunk.value, { stream: true });
				}
				const end = buffer.indexOf('\n');
				const message: unknown = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (
					typeof message === 'object' &&
					message !== null &&
					'pid' in message &&
					message.pid === child.pid &&
					'event' in message &&
					typeof message.event === 'string' &&
					'metrics' in message &&
					Array.isArray(message.metrics)
				) {
					diagnostics.push(message);
					continue;
				}
				if (
					typeof message !== 'object' ||
					message === null ||
					!('pid' in message) ||
					message.pid !== child.pid ||
					!('result' in message) ||
					typeof message.result !== 'string'
				)
					throw new Error('Invalid child signal');
				console.log(JSON.stringify(message));
				finished =
					message.result !== 'ready' && message.result !== 'locked';
				return message.result;
			}
		},
		async close(): Promise<void> {
			if (!finished) child.kill();
			const code = await child.exited;
			reader.releaseLock();
			const errors = await stderr;
			if (finished && code !== 0)
				throw new Error(`Child cleanup failed: ${errors}`);
		},
	};
}
