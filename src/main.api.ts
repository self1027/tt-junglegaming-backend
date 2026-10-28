import 'reflect-metadata';
import { createApi } from './bootstrap/create-api.js';

async function main(): Promise<void> {
	const port = Number(process.env.PORT ?? '3000');
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535');
	}
	const app = await createApi();
	app.enableShutdownHooks();
	await app.listen(port, '0.0.0.0');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
