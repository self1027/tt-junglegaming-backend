import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ESLint } from 'eslint';

const root = resolve(import.meta.dir, '..');
const fixtures = join(root, '.architecture-fixtures');
const financial = 'src/modules/financial';
const wagering = 'src/modules/wagering';

afterAll(async () => {
	await rm(fixtures, { recursive: true, force: true });
});

interface ImportCase {
	name: string;
	from: string;
	to: string;
	specifier: string;
	rule?: string;
	cycle?: boolean;
	syntax?: 'type' | 'dynamic' | 'reexport';
}

const cases: ImportCase[] = [
	{
		name: 'pending worker entrypoint can compose bootstrap',
		from: 'src/main.pending-worker.ts',
		to: 'src/bootstrap/b.ts',
		specifier: './bootstrap/b.js',
	},
	{
		name: 'publisher infrastructure rejects Financial internals',
		from: 'src/platform/messaging/outbox-publisher.ts',
		to: `${financial}/adapters/b.ts`,
		specifier: '../../modules/financial/adapters/b.js',
		rule: 'platform-independent',
	},
	{
		name: 'publisher SQS adapter cannot import bootstrap',
		from: `${wagering}/adapters/sqs/a.ts`,
		to: 'src/bootstrap/b.ts',
		specifier: '../../../../bootstrap/b.js',
		rule: 'bootstrap-is-composition-root',
	},
	{
		name: 'only the publisher entrypoint can compose its bootstrap',
		from: 'src/main.publisher.ts',
		to: 'src/bootstrap/b.ts',
		specifier: './bootstrap/b.js',
	},
	{
		name: 'Wagering domain rejects AWS SDK',
		from: `${wagering}/domain/a.ts`,
		to: `${wagering}/domain/b.ts`,
		specifier: '@aws-sdk/client-sqs',
		rule: 'domain-is-pure',
	},
	{
		name: 'Financial application rejects AWS SDK',
		from: `${financial}/application/a.ts`,
		to: `${financial}/application/b.ts`,
		specifier: '@aws-sdk/client-sqs',
		rule: 'application-no-infrastructure',
	},
	{
		name: 'Wagering application rejects AWS SDK',
		from: `${wagering}/application/a.ts`,
		to: `${wagering}/application/b.ts`,
		specifier: '@aws-sdk/client-sqs',
		rule: 'application-no-infrastructure',
	},
	{
		name: 'use case rejects SQS adapter',
		from: `${wagering}/application/a.ts`,
		to: `${wagering}/adapters/sqs/b.ts`,
		specifier: '../adapters/sqs/b.js',
		rule: 'application-no-infrastructure',
	},
	{
		name: 'Platform rejects Wagering public',
		from: 'src/platform/messaging/a.ts',
		to: `${wagering}/public/b.ts`,
		specifier: '../../modules/wagering/public/b.js',
		rule: 'platform-independent',
	},
	{
		name: 'domain rejects ORM types',
		from: `${financial}/domain/a.ts`,
		to: `${financial}/domain/b.ts`,
		specifier: '@mikro-orm/core',
		rule: 'domain-is-pure',
		syntax: 'type',
	},
	{
		name: 'application rejects ORM',
		from: `${wagering}/application/a.ts`,
		to: `${wagering}/application/b.ts`,
		specifier: '@mikro-orm/postgresql',
		rule: 'application-no-infrastructure',
	},
	{
		name: 'domain rejects Nest',
		from: `${financial}/domain/a.ts`,
		to: `${financial}/domain/b.ts`,
		specifier: '@nestjs/common',
		rule: 'domain-is-pure',
	},
	{
		name: 'domain rejects adapters',
		from: `${financial}/domain/a.ts`,
		to: `${financial}/adapters/b.ts`,
		specifier: '../adapters/b.js',
		rule: 'domain-is-pure',
	},
	{
		name: 'domain rejects platform',
		from: `${financial}/domain/a.ts`,
		to: 'src/platform/persistence/b.ts',
		specifier: '../../../platform/persistence/b.js',
		rule: 'domain-is-pure',
	},
	{
		name: 'application rejects adapters',
		from: `${financial}/application/a.ts`,
		to: `${financial}/adapters/b.ts`,
		specifier: '../adapters/b.js',
		rule: 'application-no-infrastructure',
	},
	{
		name: 'application rejects platform',
		from: `${financial}/application/a.ts`,
		to: 'src/platform/persistence/b.ts',
		specifier: '../../../platform/persistence/b.js',
		rule: 'application-no-infrastructure',
	},
	{
		name: 'financial rejects wagering public',
		from: `${financial}/application/a.ts`,
		to: `${wagering}/public/b.ts`,
		specifier: '../../wagering/public/b.js',
		rule: 'financial-independent',
	},
	{
		name: 'wagering rejects financial internals',
		from: `${wagering}/application/a.ts`,
		to: `${financial}/domain/b.ts`,
		specifier: '../../financial/domain/b.js',
		rule: 'financial-public-entrypoint',
	},
	{
		name: 'public rejects adapters',
		from: `${financial}/public/a.ts`,
		to: `${financial}/adapters/b.ts`,
		specifier: '../adapters/b.js',
		rule: 'public-contracts-only',
	},
	{
		name: 'modules reject bootstrap',
		from: `${financial}/adapters/a.ts`,
		to: 'src/bootstrap/b.ts',
		specifier: '../../../bootstrap/b.js',
		rule: 'bootstrap-is-composition-root',
	},
	{
		name: 'platform rejects modules',
		from: 'src/platform/persistence/a.ts',
		to: `${financial}/public/b.ts`,
		specifier: '../../modules/financial/public/b.js',
		rule: 'platform-independent',
	},
	{
		name: 'rejects cycles',
		from: `${financial}/domain/a.ts`,
		to: `${financial}/domain/b.ts`,
		specifier: './b.js',
		rule: 'no-cycles',
		cycle: true,
	},
	{
		name: 'rejects forbidden type imports',
		from: `${wagering}/application/a.ts`,
		to: `${financial}/domain/b.ts`,
		specifier: '../../financial/domain/b.js',
		rule: 'financial-public-entrypoint',
		syntax: 'type',
	},
	{
		name: 'rejects forbidden dynamic imports',
		from: `${financial}/application/a.ts`,
		to: `${financial}/adapters/b.ts`,
		specifier: '../adapters/b.js',
		rule: 'application-no-infrastructure',
		syntax: 'dynamic',
	},
	{
		name: 'rejects forbidden reexports',
		from: `${financial}/public/a.ts`,
		to: `${financial}/adapters/b.ts`,
		specifier: '../adapters/b.js',
		rule: 'public-contracts-only',
		syntax: 'reexport',
	},
	{
		name: 'allows application to domain',
		from: `${financial}/application/a.ts`,
		to: `${financial}/domain/b.ts`,
		specifier: '../domain/b.js',
	},
	{
		name: 'allows wagering to financial public',
		from: `${wagering}/application/a.ts`,
		to: `${financial}/public/b.ts`,
		specifier: '../../financial/public/b.js',
	},
];

describe('resolved architectural imports', () => {
	for (const entry of cases) {
		test(entry.name, async () => {
			await rm(fixtures, { recursive: true, force: true });
			for (const file of [entry.from, entry.to]) {
				await mkdir(dirname(join(fixtures, file)), { recursive: true });
			}
			await writeFile(
				join(fixtures, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						module: 'NodeNext',
						moduleResolution: 'NodeNext',
					},
				}),
			);
			let source = `import '${entry.specifier}';\nexport const a = 1;\n`;
			switch (entry.syntax) {
				case 'type':
					source = `import type { b } from '${entry.specifier}';\nexport type A = typeof b;\n`;
					break;
				case 'dynamic':
					source = `export const a = import('${entry.specifier}');\n`;
					break;
				case 'reexport':
					source = `export * from '${entry.specifier}';\n`;
					break;
				case undefined:
					break;
			}
			await writeFile(join(fixtures, entry.from), source);
			await writeFile(
				join(fixtures, entry.to),
				entry.cycle === true
					? "import './a.js';\nexport const b = 1;\n"
					: 'export const b = 1;\n',
			);
			const result = Bun.spawnSync(
				[
					process.execPath,
					join(
						root,
						'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
					),
					'src',
					'--config',
					join(root, '.dependency-cruiser.cjs'),
					'--output-type',
					'err-long',
				],
				{ cwd: fixtures, stdout: 'pipe', stderr: 'pipe' },
			);
			const output = result.stdout.toString() + result.stderr.toString();
			if (entry.rule === undefined) {
				expect(output).not.toContain('error ');
				expect(result.exitCode).toBe(0);
			} else {
				expect(output).toContain(entry.rule);
				expect(result.exitCode).toBe(1);
			}
		});
	}
});

describe('ESLint architectural guards', () => {
	const eslint = new ESLint({ cwd: root });

	test('publisher loop and SQS adapter reject direct financial mutations', async () => {
		for (const filePath of [
			'src/modules/wagering/adapters/worker/pending-reference-worker.ts',
			'src/platform/messaging/outbox-publisher.ts',
			'src/modules/wagering/adapters/sqs/sqs-event-publisher.ts',
		]) {
			const result = await eslint.lintText(
				'export function apply(wallet: { credit(): void }): void { wallet.credit(); }',
				{ filePath },
			);
			expect(
				result
					.flatMap(file => file.messages)
					.some(message =>
						message.message.includes('Financial effects belong'),
					),
			).toBe(true);
		}
	});

	test('pending resolver rejects insertion of another WagerTransaction', async () => {
		const result = await eslint.lintText(
			'export async function resolve(context: { transactions: { insert(): Promise<void> } }): Promise<void> { await context.transactions.insert(); }',
			{
				filePath:
					'src/modules/wagering/application/resolve-pending-wager.use-case.ts',
			},
		);
		expect(
			result
				.flatMap(file => file.messages)
				.some(message =>
					message.message.includes('existing WagerTransaction'),
				),
		).toBe(true);
	});

	test('pending resolution repository rejects an independent transaction', async () => {
		const result = await eslint.lintText(
			'export class MikroOrmPendingResolutionRepository { save(em: { commit(): void }): void { em.commit(); } }',
			{
				filePath:
					'src/modules/wagering/adapters/persistence/mikro-orm-pending.repository.ts',
			},
		);
		expect(
			result
				.flatMap(file => file.messages)
				.some(message =>
					message.message.includes('supplied TransactionSession'),
				),
		).toBe(true);
	});

	test('rejects financial mutations in the consumer', async () => {
		const result = await eslint.lintText(
			'export function process(wallet: { debit(): void }): void { wallet.debit(); }',
			{ filePath: 'src/platform/messaging/reliable-consumer.ts' },
		);
		expect(
			result
				.flatMap(file => file.messages)
				.some(message =>
					message.message.includes('Financial effects belong'),
				),
		).toBe(true);
	});

	test('rejects independent commit/transactions in the Inbox adapter', async () => {
		for (const method of [
			'commit',
			'transactional',
			'begin',
			'rollback',
			'flush',
		]) {
			const result = await eslint.lintText(
				`export function save(em: { ${method}(): void }): void { em.${method}(); }`,
				{
					filePath:
						'src/modules/wagering/adapters/persistence/mikro-orm-inbox.repository.ts',
				},
			);
			expect(
				result
					.flatMap(file => file.messages)
					.some(message =>
						message.message.includes('Inbox must use the supplied'),
					),
			).toBe(true);
		}
	});

	test('rejects computed import paths', async () => {
		const result = await eslint.lintText(
			"const path = './bootstrap/api.module.js'; export const loaded = import(path);",
			{ filePath: 'src/main.api.ts' },
		);
		expect(
			result
				.flatMap(file => file.messages)
				.some(message => message.message.includes('literal paths')),
		).toBe(true);
	});

	test('rejects controller decisions', async () => {
		const result = await eslint.lintText(
			'export function handler(): number { if (true) { return 1; } return 0; }',
			{ filePath: 'src/platform/observability/health.controller.ts' },
		);
		expect(
			result
				.flatMap(file => file.messages)
				.some(message => message.ruleId === 'no-restricted-syntax'),
		).toBe(true);
	});

	test('rejects composition outside bootstrap', async () => {
		const result = await eslint.lintText(
			"import { Module } from '@nestjs/common'; @Module({}) export class MisplacedModule {}",
			{ filePath: 'src/platform/observability/health.controller.ts' },
		);
		expect(
			result
				.flatMap(file => file.messages)
				.some(message =>
					message.message.includes('composition belongs'),
				),
		).toBe(true);
	});
});
