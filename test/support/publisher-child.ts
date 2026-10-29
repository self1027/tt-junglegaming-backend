export interface PublisherChild {
	readonly pid: number;
	readonly events: Record<string, unknown>[];
	wait(event: string, eventId?: string): Promise<Record<string, unknown>>;
	send(value: string): Promise<void>;
	kill(): Promise<void>;
	close(): Promise<void>;
}
export async function startPublisher(
	env: NodeJS.ProcessEnv,
	mode = 'normal',
): Promise<PublisherChild> {
	const child = Bun.spawn(
		[process.execPath, 'test/support/publisher-process.ts'],
		{
			env: { ...env, PUBLISHER_TEST_MODE: mode },
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const events: Record<string, unknown>[] = [];
	const stderr = new Response(child.stderr).text();
	let killed = false;
	const reading = (async (): Promise<void> => {
		let buffer = '';
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				try {
					const value: unknown = JSON.parse(line);
					if (typeof value === 'object' && value !== null)
						events.push(value as Record<string, unknown>);
				} catch {
					/* Ignore framework output. */
				}
			}
		}
	})();
	const send = async (value: string): Promise<void> => {
		await child.stdin.write(`${value}\n`);
		await child.stdin.flush();
	};
	const result: PublisherChild = {
		pid: child.pid,
		events,
		send,
		wait: async (event, eventId) => {
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const found = events.find(
					row =>
						row.event === event &&
						(eventId === undefined || row.eventId === eventId),
				);
				if (found !== undefined) return found;
				if (child.exitCode !== null)
					throw new Error(
						`Publisher ${String(child.pid)} exited: ${await stderr}`,
					);
				await Bun.sleep(20);
			}
			throw new Error(
				`Publisher ${String(child.pid)} timed out on ${event}: ${JSON.stringify(events)}`,
			);
		},
		kill: async () => {
			killed = true;
			child.kill(9);
			await child.exited;
		},
		close: async () => {
			if (!killed && child.exitCode === null) {
				await send('release');
				await send('stop');
			}
			const timeout = setTimeout(() => {
				child.kill(9);
			}, 8000);
			try {
				const code = await child.exited;
				await reading;
				const errors = await stderr;
				if (!killed && code !== 0)
					throw new Error(
						`Publisher ${String(child.pid)} shutdown ${String(code)}: ${errors}`,
					);
			} finally {
				clearTimeout(timeout);
			}
		},
	};
	try {
		await result.wait('ready');
		return result;
	} catch (error) {
		await result.kill();
		await result.close();
		throw error;
	}
}
