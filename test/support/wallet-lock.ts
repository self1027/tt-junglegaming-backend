import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/platform/persistence/config.js';
import { WalletRow } from '../../src/platform/persistence/models.js';

const orm = await MikroORM.init(persistenceConfig());
try {
	const walletId = process.argv[2];
	if (walletId === undefined) {
		throw new Error('walletId is required');
	}
	await orm.em.fork().transactional(async em => {
		await em.findOneOrFail(WalletRow, walletId, {
			lockMode: LockMode.PESSIMISTIC_WRITE_OR_FAIL,
		});
	});
	console.log(JSON.stringify({ pid: process.pid, result: 'acquired' }));
} catch (error) {
	if (error instanceof Error && 'code' in error && error.code === '55P03') {
		console.log(JSON.stringify({ pid: process.pid, result: 'locked' }));
	} else {
		throw error;
	}
} finally {
	await orm.close(true);
}
