import type { TestPostgres } from './postgres.js';

export interface HttpServer {
	readonly pid: number;
	readonly url: string;
	wait(event: string): Promise<Record<string, unknown>>;
	send(event: string): Promise<void>;
	close(): Promise<void>;
}

export async function startHttpServer(
	postgres: TestPostgres,
): Promise<HttpServer> {
	const child = Bun.spawn(
		[process.execPath, 'test/support/http-process.ts'],
		{ env: postgres.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
	);
	const messages: Record<string, unknown>[] = [];
	let stderr = '';
	const errors = new Response(child.stderr).text().then(value => {
		stderr = value;
	});
	const signals = new Set<() => void>();
	const reader = (async (): Promise<void> => {
		let buffer = '';
		for await (const chunk of child.stdout) {
			buffer += new TextDecoder().decode(chunk);
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				try {
					const message: unknown = JSON.parse(line);
					if (typeof message === 'object' && message !== null)
						messages.push(message as Record<string, unknown>);
				} catch {
					/* Nest startup output is not a control message. */
				}
				for (const notify of signals) notify();
			}
		}
	})();
	async function wait(event: string): Promise<Record<string, unknown>> {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const index = messages.findIndex(
				message => message.event === event,
			);
			if (index >= 0) {
				const message = messages.splice(index, 1)[0];
				if (message !== undefined) return message;
			}
			if (child.exitCode !== null)
				throw new Error(`HTTP process exited: ${stderr}`);
			await new Promise<void>(resolve => {
				const timeout = setTimeout(done, 100);
				function done(): void {
					clearTimeout(timeout);
					signals.delete(done);
					resolve();
				}
				signals.add(done);
			});
		}
		throw new Error(`Timed out waiting for ${event}: ${stderr}`);
	}
	try {
		const ready = await wait('ready');
		if (typeof ready.url !== 'string')
			throw new Error('Missing HTTP address');
		return {
			pid: child.pid,
			url: ready.url,
			wait,
			send: async (event): Promise<void> => {
				await child.stdin.write(`${event}\n`);
				await child.stdin.flush();
			},
			close: async (): Promise<void> => {
				const timeout = setTimeout(() => {
					child.kill(9);
				}, 5_000);
				try {
					await child.stdin.end();
					await child.exited;
					await reader;
					await errors;
				} finally {
					clearTimeout(timeout);
				}
			},
		};
	} catch (error) {
		child.kill(9);
		await child.exited;
		await reader;
		await errors;
		throw error;
	}
}
