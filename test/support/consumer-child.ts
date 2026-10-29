export interface ConsumerChild {
	readonly pid: number;
	readonly events: Record<string, unknown>[];
	wait(event: string, messageId?: string): Promise<Record<string, unknown>>;
	send(value: string): Promise<void>;
	kill(): Promise<void>;
	close(): Promise<void>;
}

export async function startConsumer(
	env: NodeJS.ProcessEnv,
	mode = 'normal',
): Promise<ConsumerChild> {
	const child = Bun.spawn(
		[process.execPath, 'test/support/consumer-process.ts'],
		{
			env: {
				...env,
				SQS_CONCURRENCY: env.SQS_CONCURRENCY ?? '1',
				SQS_BATCH_SIZE: '1',
				CONSUMER_TEST_MODE: mode,
			},
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const events: Record<string, unknown>[] = [];
	const stderr = new Response(child.stderr).text();
	let killed = false;
	const read = (async (): Promise<void> => {
		let buffer = '';
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				try {
					const data: unknown = JSON.parse(line);
					if (typeof data === 'object' && data !== null)
						events.push(data as Record<string, unknown>);
				} catch {
					/* Framework output is not a control event. */
				}
			}
		}
	})();
	const send = async (value: string): Promise<void> => {
		await child.stdin.write(`${value}\n`);
		await child.stdin.flush();
	};
	const wait = async (
		event: string,
		messageId?: string,
	): Promise<Record<string, unknown>> => {
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			const found = events.find(
				record =>
					record.event === event &&
					(messageId === undefined || record.messageId === messageId),
			);
			if (found !== undefined) return found;
			if (child.exitCode !== null)
				throw new Error(
					`Consumer ${String(child.pid)} exited: ${await stderr}`,
				);
			await Bun.sleep(20);
		}
		throw new Error(
			`Consumer ${String(child.pid)} timed out on ${event}; events=${JSON.stringify(events)}`,
		);
	};
	const result: ConsumerChild = {
		pid: child.pid,
		events,
		wait,
		send,
		kill: async (): Promise<void> => {
			killed = true;
			child.kill(9);
			await child.exited;
		},
		close: async (): Promise<void> => {
			if (!killed && child.exitCode === null) {
				await send('release');
				await send('stop');
			}
			const timeout = setTimeout(() => {
				child.kill(9);
			}, 8000);
			try {
				const code = await child.exited;
				await read;
				const errors = await stderr;
				if (!killed && code !== 0)
					throw new Error(
						`Consumer shutdown (${String(code)}): ${errors}`,
					);
			} finally {
				clearTimeout(timeout);
			}
		},
	};
	try {
		const ready = await wait('ready');
		const duration = Number(env.SQS_PROCESSING_MS ?? '120000');
		if (
			ready.transactionTimeoutMs !== duration ||
			ready.statementTimeoutMs !== duration
		)
			throw new Error('Consumer PostgreSQL timeouts were not applied');
		return result;
	} catch (error) {
		await result.kill();
		await result.close();
		throw error;
	}
}
