import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const tsFiles = ['**/*.ts'];
const importGuards = [
	{
		selector: 'ImportExpression[source.type!="Literal"]',
		message:
			'Imports must use literal paths so architecture checks can resolve them.',
	},
	{
		selector:
			'ImportSpecifier[imported.name="Module"][local.name!="Module"]',
		message:
			'Keep the Module decorator name visible for composition checks.',
	},
];
const compositionGuard = {
	selector:
		'Decorator[expression.callee.name="Module"], Decorator[expression.callee.property.name="Module"]',
	message: 'Nest module composition belongs in src/bootstrap/.',
};

export default tseslint.config(
	{
		ignores: [
			'dist/**',
			'coverage/**',
			'node_modules/**',
			'.architecture-fixtures/**',
		],
	},
	{
		linterOptions: {
			noInlineConfig: true,
			reportUnusedDisableDirectives: 'error',
		},
	},
	js.configs.recommended,
	{
		files: ['**/*.mjs', '**/*.cjs'],
		languageOptions: { globals: { module: 'readonly' } },
	},
	{
		files: tsFiles,
		extends: [
			...tseslint.configs.strictTypeChecked,
			...tseslint.configs.stylisticTypeChecked,
		],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'no-restricted-syntax': ['error', ...importGuards],
			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/explicit-function-return-type': 'error',
			'@typescript-eslint/strict-boolean-expressions': 'error',
			'@typescript-eslint/switch-exhaustiveness-check': 'error',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-ignore': true,
					'ts-nocheck': true,
					'ts-check': false,
					'ts-expect-error': 'allow-with-description',
					minimumDescriptionLength: 10,
				},
			],
		},
	},
	{
		files: ['src/bootstrap/**/*.module.ts'],
		rules: {
			'@typescript-eslint/no-extraneous-class': [
				'error',
				{ allowWithDecorator: true },
			],
		},
	},
	{
		files: [
			'src/modules/**/domain/**/*.ts',
			'src/modules/**/application/**/*.ts',
			'src/modules/**/public/**/*.ts',
		],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							regex: '^(?!\\.)',
							message:
								'Inner layers use local contracts; external frameworks and infrastructure belong in adapters.',
						},
					],
				},
			],
			'@typescript-eslint/no-require-imports': 'error',
		},
	},
	{
		files: ['src/**/*.ts'],
		ignores: ['src/bootstrap/**'],
		rules: {
			'no-restricted-syntax': [
				'error',
				...importGuards,
				compositionGuard,
			],
		},
	},
	{
		files: ['src/**/*.controller.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				...importGuards,
				{
					selector:
						'IfStatement, SwitchStatement, ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement, ConditionalExpression, BinaryExpression, AssignmentExpression, UpdateExpression, NewExpression',
					message:
						'Controllers only translate HTTP and delegate; move decisions and computation to application/domain.',
				},
				compositionGuard,
			],
		},
	},
	prettier,
);
