const modules = ['financial', 'wagering'];

module.exports = {
	forbidden: [
		{
			name: 'no-cycles',
			severity: 'error',
			from: {},
			to: { circular: true },
		},
		{
			name: 'no-unresolved',
			severity: 'error',
			from: {},
			to: { couldNotResolve: true },
		},
		{
			name: 'domain-is-pure',
			severity: 'error',
			from: { path: '^src/modules/[^/]+/domain/' },
			to: { pathNot: '^src/modules/[^/]+/(domain|public)/' },
		},
		{
			name: 'application-no-infrastructure',
			severity: 'error',
			from: { path: '^src/modules/[^/]+/application/' },
			to: { pathNot: '^src/modules/[^/]+/(domain|application|public)/' },
		},
		{
			name: 'public-contracts-only',
			severity: 'error',
			from: { path: '^src/modules/[^/]+/public/' },
			to: { pathNot: '^src/modules/[^/]+/(domain|public)/' },
		},
		{
			name: 'financial-independent',
			severity: 'error',
			from: { path: '^src/modules/financial/' },
			to: { path: '^src/modules/wagering/' },
		},
		...modules.map(name => ({
			name: `${name}-public-entrypoint`,
			severity: 'error',
			from: { path: '^src/modules/', pathNot: `^src/modules/${name}/` },
			to: {
				path: `^src/modules/${name}/`,
				pathNot: `^src/modules/${name}/public/`,
			},
		})),
		{
			name: 'bootstrap-is-composition-root',
			severity: 'error',
			from: {
				path: '^src/',
				pathNot:
					'^src/(bootstrap/|main\\.(api|consumer|publisher|pending-worker)\\.ts$)',
			},
			to: { path: '^src/bootstrap/' },
		},
		{
			name: 'platform-independent',
			severity: 'error',
			from: { path: '^src/platform/' },
			to: { path: '^src/modules/' },
		},
		{
			name: 'production-no-dev-dependencies',
			severity: 'error',
			from: { path: '^src/' },
			to: { dependencyTypes: ['npm-dev'] },
		},
	],
	options: {
		tsConfig: { fileName: 'tsconfig.json' },
		tsPreCompilationDeps: true,
		doNotFollow: { path: 'node_modules' },
	},
};
