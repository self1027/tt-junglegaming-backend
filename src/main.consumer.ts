import 'reflect-metadata';
import { runConsumer } from './bootstrap/run-consumer.js';

runConsumer().catch(() => {
	console.error(
		JSON.stringify({ event: 'consumer_failed', pid: process.pid }),
	);
	process.exitCode = 1;
});
