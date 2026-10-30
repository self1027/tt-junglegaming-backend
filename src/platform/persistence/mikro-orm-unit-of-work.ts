import { IsolationLevel, TransactionPropagation } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransactionSession } from './transaction-session.js';
import { postgresError } from './postgres-error.js';
import { diagnostic } from '../observability/diagnostic.js';

export class MikroOrmUnitOfWork<Context> {
	constructor(
		private readonly manager: EntityManager,
		private readonly createContext: (
			session: TransactionSession,
		) => Context,
	) {}

	async execute<T>(
		work: (context: Context) => Promise<T>,
		options?: { readonly readOnly: true },
	): Promise<T> {
		const fork = this.manager.fork({
			clear: true,
			useContext: false,
			keepTransactionContext: false,
		});
		return fork
			.transactional(
				async em => {
					if (options?.readOnly === true)
						await em.execute('set transaction read only');
					const session = new TransactionSession(em);
					try {
						return await work(this.createContext(session));
					} finally {
						session.close();
					}
				},
				{
					isolationLevel:
						options?.readOnly === true
							? IsolationLevel.REPEATABLE_READ
							: IsolationLevel.READ_COMMITTED,
					propagation: TransactionPropagation.REQUIRES_NEW,
				},
			)
			.catch((error: unknown) => {
				const code = postgresError(error).code;
				if (
					code !== undefined &&
					['55P03', '40P01', '40001'].includes(code)
				)
					diagnostic({ event: 'database_conflict', code });
				throw error;
			});
	}
}
