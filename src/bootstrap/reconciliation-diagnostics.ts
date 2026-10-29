import type { ReconciliationDiagnostics } from '../modules/financial/public/wallet-api.js';

export class WalletReconciliationDiagnostics implements ReconciliationDiagnostics {
	#divergences = 0;

	get divergences(): number {
		return this.#divergences;
	}

	divergence(walletId: string): void {
		this.#divergences++;
		console.warn(
			JSON.stringify({
				event: 'wallet_reconciliation_divergence',
				walletId,
				divergences: this.#divergences,
			}),
		);
	}
}
