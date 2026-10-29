import { Migration } from '@mikro-orm/migrations';

export class Migration202610280002 extends Migration {
	override up(): void {
		// Existing incompatible history aborts migration; never discard financial records.
		this.addSql(`create unique index wager_processed_direct_reversal_unique
			on wager_transactions (reference_transaction_id)
			where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`);
	}

	override down(): void {
		this.addSql('drop index wager_processed_direct_reversal_unique');
	}
}
