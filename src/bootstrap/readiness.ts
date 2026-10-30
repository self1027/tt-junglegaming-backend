import type { MikroORM } from '@mikro-orm/postgresql';
import type { MessageTransport } from '../platform/messaging/transport.js';
import type {
	Readiness,
	ReadinessResult,
} from '../platform/observability/readiness.js';

export function createReadiness(
	orm: MikroORM,
	sqs: MessageTransport | null = null,
): Readiness {
	return {
		check: async (): Promise<ReadinessResult> => {
			let postgres: 'up' | 'down' = 'up';
			let queue: 'up' | 'down' | 'not_configured' =
				sqs === null ? 'not_configured' : 'up';
			try {
				await orm.em.execute('select 1');
			} catch {
				postgres = 'down';
			}
			try {
				await sqs?.check();
			} catch {
				queue = 'down';
			}
			return {
				status:
					postgres === 'up' && queue === 'up' ? 'ready' : 'not_ready',
				checks: { postgres, sqs: queue },
			};
		},
	};
}
