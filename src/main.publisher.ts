import 'reflect-metadata';
import { runPublisher } from './bootstrap/run-publisher.js';

runPublisher().catch(() => {
	console.error(
		JSON.stringify({ event: 'publisher_failed', pid: process.pid }),
	);
	process.exitCode = 1;
});
