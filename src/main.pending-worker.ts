import 'reflect-metadata';
import { runPendingWorker } from './bootstrap/run-pending-worker.js';

runPendingWorker().catch(() => {
	console.error(
		JSON.stringify({ event: 'pending_worker_failed', pid: process.pid }),
	);
	process.exitCode = 1;
});
