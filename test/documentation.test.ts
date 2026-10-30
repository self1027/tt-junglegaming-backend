import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { persistenceConfig } from '../src/platform/persistence/config.js';
import { sqsConfig } from '../src/platform/messaging/sqs-config.js';
import { publisherConfig } from '../src/platform/messaging/publisher-config.js';
import { pendingWorkerConfig } from '../src/modules/wagering/adapters/worker/pending-config.js';
import { parseWagerMessage } from '../src/modules/wagering/adapters/sqs/wager-message.js';
import { persistedEvent } from '../src/modules/wagering/adapters/sqs/persisted-event.js';

const listing = Bun.spawnSync([
	'git',
	'ls-files',
	'--cached',
	'--others',
	'--exclude-standard',
	'-z',
	'*.md',
]);
if (listing.exitCode !== 0) throw new Error('Cannot inventory Markdown');
const paths = [
	...new Set(
		listing.stdout
			.toString()
			.split('\0')
			.filter(path => path !== '' && existsSync(path)),
	),
];
const documents = new Map(
	await Promise.all(
		paths.map(
			async path => [resolve(path), await Bun.file(path).text()] as const,
		),
	),
);
const prose = (text: string): string =>
	text.replace(/```[^\n]*\n[\s\S]*?```/g, '');

function anchors(text: string): Set<string> {
	const result = new Set<string>();
	const used = new Map<string, number>();
	for (const match of prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
		const title = (match[1] ?? '')
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
			.replace(/ /g, '-');
		const count = used.get(title) ?? 0;
		used.set(title, count + 1);
		result.add(count === 0 ? title : `${title}-${String(count)}`);
	}
	return result;
}

test('repository Markdown links, anchors and skill frontmatter resolve', () => {
	const failures: string[] = [];
	for (const [path, text] of documents) {
		for (const match of prose(text).matchAll(
			/\[[^\]\n]*\]\(([^)\n]+)\)/g,
		)) {
			const target = match[1] ?? '';
			if (/^[a-z][\w+.-]*:/i.test(target)) continue;
			const [file = '', fragment] = target.split('#');
			const destination =
				file === ''
					? path
					: resolve(dirname(path), decodeURIComponent(file));
			if (!existsSync(destination))
				failures.push(`${path}: missing ${target}`);
			else if (
				fragment !== undefined &&
				documents.has(destination) &&
				!anchors(documents.get(destination) ?? '').has(
					decodeURIComponent(fragment),
				)
			)
				failures.push(`${path}: missing anchor ${target}`);
		}
		if (path.endsWith('SKILL.md')) {
			expect(text.replace(/^\uFEFF/, '')).toMatch(
				/^---\r?\nname: .+\r?\ndescription: /,
			);
			expect(text.split(/^---\r?$/m)).toHaveLength(3);
		}
	}
	expect(failures).toEqual([]);
});

test('current documentation uses existing Bun scripts, tests and valid JSON', async () => {
	const pkg = (await Bun.file('package.json').json()) as {
		scripts: Record<string, string>;
	};
	for (const [path, text] of documents) {
		if (
			path.includes(resolve('docs/history')) ||
			path === resolve('docs/challenge.md')
		)
			continue;
		for (const match of text.matchAll(/\bbun run ([\w:-]+)/g))
			expect(
				Object.hasOwn(pkg.scripts, match[1] ?? ''),
				`${path}: ${match[0]}`,
			).toBe(true);
		for (const match of text.matchAll(
			/\bbun test ((?:test\/[\w./-]+\.ts\s*)+)/g,
		))
			for (const file of (match[1] ?? '').trim().split(/\s+/))
				expect(existsSync(file), `${path}: ${file}`).toBe(true);
		for (const match of text.matchAll(/```json\r?\n([\s\S]*?)```/g))
			expect(
				() => JSON.parse(match[1] ?? '') as unknown,
				path,
			).not.toThrow();
	}
	for (const command of Object.values(pkg.scripts))
		for (const match of command.matchAll(/(?:src|dist)\/main\.[\w.-]+/g))
			expect(
				existsSync(
					match[0].replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
				),
			).toBe(true);
});

test('documented HTTP routes match controllers and example configuration is accepted', async () => {
	const http = await Bun.file('docs/contracts/http.md').text();
	for (const file of [
		'src/modules/financial/adapters/http/wallet.controller.ts',
		'src/modules/wagering/adapters/http/wager.controller.ts',
		'src/platform/observability/health.controller.ts',
	]) {
		const source = await Bun.file(file).text();
		const prefix = /@Controller\('([^']*)'\)/.exec(source)?.[1] ?? '';
		for (const match of source.matchAll(/@(Get|Post)\((?:'([^']*)')?\)/g)) {
			const route = [prefix, match[2]].filter(Boolean).join('/');
			expect(http).toContain(
				`${match[1]?.toUpperCase() ?? ''} /${route}`,
			);
		}
	}
	const env = Object.fromEntries(
		(await Bun.file('.env.example').text())
			.split(/\r?\n/)
			.filter(line => line !== '' && !line.startsWith('#'))
			.map(line => {
				const split = line.indexOf('=');
				return [line.slice(0, split), line.slice(split + 1)];
			}),
	);
	expect(() => persistenceConfig(env)).not.toThrow();
	expect(() => sqsConfig(env)).not.toThrow();
	expect(() => publisherConfig(env)).not.toThrow();
	expect(() => pendingWorkerConfig(env)).not.toThrow();
});

test('published SQS and integration event examples pass the runtime parsers', async () => {
	const sqs = await Bun.file('docs/contracts/sqs-commands.md').text();
	const body = /```json\r?\n([\s\S]*?)```/.exec(sqs)?.[1];
	if (body === undefined) throw new Error('Missing command example');
	expect((await parseWagerMessage(body)).command.amount.amount).toBe('25.00');
	const events = await Bun.file(
		'docs/contracts/integration-events.md',
	).text();
	const payload = JSON.parse(
		/```json\r?\n([\s\S]*?)```/.exec(events)?.[1] ?? '',
	) as Record<string, unknown>;
	const string = (key: string): string => {
		const value = payload[key];
		if (typeof value !== 'string') throw new Error(`Missing ${key}`);
		return value;
	};
	expect(
		persistedEvent({
			eventId: string('eventId'),
			eventType: string('eventType'),
			eventVersion: 1,
			aggregateId: string('aggregateId'),
			correlationId: string('correlationId'),
			causationId: null,
			occurredAt: new Date(string('occurredAt')),
			payload,
		}).deduplicationId,
	).toBe(string('eventId'));
});
