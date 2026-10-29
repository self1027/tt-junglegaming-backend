import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmWalletRepository } from '../modules/financial/adapters/persistence/mikro-orm-wallet.repository.js';
import { MikroOrmLedgerRepository } from '../modules/financial/adapters/persistence/mikro-orm-ledger.repository.js';
import { MikroOrmOpeningRepository } from '../modules/financial/adapters/persistence/mikro-orm-opening.repository.js';
import { MikroOrmWagerTransactionRepository } from '../modules/wagering/adapters/persistence/mikro-orm-wager-transaction.repository.js';
import type { WageringUnitOfWork } from '../modules/wagering/public/persistence.js';
import { MikroOrmIdempotencyRepository } from '../modules/wagering/adapters/persistence/mikro-orm-idempotency.repository.js';
import { MikroOrmOutboxRepository } from '../modules/wagering/adapters/persistence/mikro-orm-outbox.repository.js';
import { MikroOrmUnitOfWork } from '../platform/persistence/mikro-orm-unit-of-work.js';

export function createUnitOfWork(orm: MikroORM): WageringUnitOfWork {
	return new MikroOrmUnitOfWork(orm.em, session => ({
		wallets: new MikroOrmWalletRepository(session),
		ledger: new MikroOrmLedgerRepository(session),
		openings: new MikroOrmOpeningRepository(session),
		transactions: new MikroOrmWagerTransactionRepository(session),
		idempotency: new MikroOrmIdempotencyRepository(session),
		outbox: new MikroOrmOutboxRepository(session),
	}));
}
