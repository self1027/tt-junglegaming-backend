import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerUseCase } from '../modules/wagering/application/process-wager.use-case.js';
import { createUnitOfWork } from './persistence.js';

export function createProcessWagerUseCase(orm: MikroORM): ProcessWagerUseCase {
	return new ProcessWagerUseCase(createUnitOfWork(orm));
}
