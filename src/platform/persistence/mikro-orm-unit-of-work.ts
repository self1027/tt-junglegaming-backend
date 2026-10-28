import { IsolationLevel, TransactionPropagation } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransactionSession } from './transaction-session.js';

export class MikroOrmUnitOfWork<Context> {
	constructor(
		private readonly manager: EntityManager,
		private readonly createContext: (
			session: TransactionSession,
		) => Context,
	) {}

	async execute<T>(work: (context: Context) => Promise<T>): Promise<T> {
		const fork = this.manager.fork({
			clear: true,
			useContext: false,
			keepTransactionContext: false,
		});
		return fork.transactional(
			async em => {
				const session = new TransactionSession(em);
				try {
					return await work(this.createContext(session));
				} finally {
					session.close();
				}
			},
			{
				isolationLevel: IsolationLevel.READ_COMMITTED,
				propagation: TransactionPropagation.REQUIRES_NEW,
			},
		);
	}
}
