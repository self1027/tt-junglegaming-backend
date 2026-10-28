import type { EntityManager } from '@mikro-orm/postgresql';

export class TransactionSession {
	#active = true;

	constructor(private readonly manager: EntityManager) {}

	get em(): EntityManager {
		if (!this.#active || !this.manager.isInTransaction()) {
			throw new Error('Transaction context is not active');
		}
		return this.manager;
	}

	close(): void {
		this.#active = false;
	}
}
