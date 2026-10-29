import type { MikroORM } from '@mikro-orm/postgresql';
import type {
	Readiness,
	ReadinessResult,
} from '../platform/observability/readiness.js';

export function createReadiness(orm: MikroORM): Readiness {
	return {
		check: async (): Promise<ReadinessResult> => {
			let postgres: 'up' | 'down' = 'up';
			try {
				await orm.em.execute('select 1');
			} catch {
				postgres = 'down';
			}
			return {
				status: 'not_ready',
				checks: { postgres, sqs: 'not_configured' },
			};
		},
	};
}
