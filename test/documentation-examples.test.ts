import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { command } from './support/postgres.js';
import { startConsumer } from './support/consumer-child.js';
import { publisherSqsSuite } from './support/publisher-sqs-suite.js';

const suite = publisherSqsSuite();

test('documented curl and awslocal examples run against disposable HTTP/PostgreSQL/SQS', async () => {
	const http = await Bun.file('docs/contracts/http.md').text();
	const script = /```sh\r?\n([\s\S]*?)```/.exec(http)?.[1];
	if (script === undefined) throw new Error('Missing curl walkthrough');
	const shell =
		process.platform === 'win32'
			? resolve(
					await command(['git', '--exec-path']),
					'../../../bin/bash.exe',
				)
			: 'bash';
	const output = await command([
		shell,
		'--noprofile',
		'--norc',
		'-ec',
		script.replace(
			'BASE=http://localhost:3000',
			`BASE=${suite.apiBaseUrl()}`,
		) + '\necho DOC_WALLET=$WALLET_ID\necho DOC_TX=$TX',
	]);
	const walletId = /DOC_WALLET=([\da-f-]+)/.exec(output)?.[1];
	const externalId = /DOC_TX=([^\r\n]+)/.exec(output)?.[1];
	if (walletId === undefined || externalId === undefined)
		throw new Error('Walkthrough did not create identities');
	const query = async (path: string): Promise<Record<string, unknown>> => {
		const response = await fetch(`${suite.apiBaseUrl()}${path}`);
		expect(response.status).toBe(200);
		return response.json() as Promise<Record<string, unknown>>;
	};
	const wallet = await query(`/wallets/${walletId}`);
	expect(wallet.balance).toEqual({ amount: '75.00', currency: 'BRL' });
	expect(
		await query(
			`/providers/provider-a/wagering/transactions/${externalId}`,
		),
	).toMatchObject({ status: 'PROCESSED' });

	const env = suite.env;
	const consumer = await startConsumer(env);
	suite.children.push(consumer);
	const publisher = await suite.child();
	await publisher.send('start');
	const contract = await Bun.file('docs/contracts/sqs-commands.md').text();
	const envelope = JSON.parse(
		/```json\r?\n([\s\S]*?)```/.exec(contract)?.[1] ?? '',
	) as { messageId: string; data: Record<string, unknown> };
	envelope.messageId = crypto.randomUUID();
	envelope.data.walletId = walletId;
	envelope.data.playerId = wallet.playerId;
	const directory = await mkdtemp(join(tmpdir(), 'dwp-docs-'));
	if (dirname(resolve(directory)) !== resolve(tmpdir()))
		throw new Error('Unexpected example temp directory');
	try {
		const file = join(directory, 'message.json');
		await Bun.write(file, JSON.stringify(envelope));
		const guide = await Bun.file('docs/operations/consumer.md').text();
		const block = [...guide.matchAll(/```sh\r?\n([\s\S]*?)```/g)]
			.map(match => match[1] ?? '')
			.find(value => value.includes('awslocal sqs send-message'));
		if (block === undefined)
			throw new Error('Missing awslocal walkthrough');
		const project = suite.sqs.network.replace(/_default$/, '');
		const run = async (line: string): Promise<string> => {
			const args = line.trim().split(/\s+/);
			args[args.indexOf('--project-name') + 1] = project;
			const queue = args.indexOf('--queue-url');
			if (queue !== -1)
				args[queue + 1] =
					`http://localhost:4566${new URL(line.includes('receive-message') ? suite.outputQueueUrl() : suite.sqs.queueUrl).pathname}`;
			const input = args.indexOf('message.json');
			if (input !== -1) args[input] = file;
			const group = args.indexOf('--message-group-id');
			if (group !== -1) args[group + 1] = walletId;
			const dedup = args.indexOf('--message-deduplication-id');
			if (dedup !== -1) args[dedup + 1] = envelope.messageId;
			args.splice(2, 0, '--env-file', '.env.example');
			return command(args, env);
		};
		for (const line of block
			.split(/\r?\n/)
			.filter(value => value.startsWith('docker ')))
			await run(line);
		await consumer.wait('acked', envelope.messageId);
		await suite.published(4);
		const receive = [...guide.matchAll(/```sh\r?\n([\s\S]*?)```/g)]
			.map(match => match[1] ?? '')
			.find(value => value.includes('awslocal sqs receive-message'));
		if (receive === undefined)
			throw new Error('Missing event inspection command');
		const observed = JSON.parse(await run(receive)) as {
			Messages?: unknown[];
		};
		expect(observed.Messages?.length).toBeGreaterThan(0);
		expect((await query(`/wallets/${walletId}`)).balance).toEqual({
			amount: '50.00',
			currency: 'BRL',
		});
		await suite.reconcile(walletId);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
