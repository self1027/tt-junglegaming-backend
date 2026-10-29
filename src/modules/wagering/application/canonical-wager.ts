import { Money } from '../../financial/public/index.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import type { WagerInput } from '../domain/wager-transaction.js';
import type { ProcessWagerCommand } from '../public/process-wager.js';
import { InvalidWagerOperationError } from '../domain/errors.js';

export async function prepareWager(
	command: ProcessWagerCommand,
): Promise<
	WagerInput & { readonly payloadHash: string; readonly walletId?: string }
> {
	if (
		command.walletId !== undefined &&
		(typeof command.walletId !== 'string' ||
			!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
				command.walletId,
			))
	)
		throw new InvalidWagerOperationError('Invalid walletId');
	const props = {
		...(command.walletId === undefined
			? {}
			: { walletId: command.walletId.toLowerCase() }),
		providerId: command.providerId,
		externalTransactionId: command.externalTransactionId,
		idempotencyKey: command.idempotencyKey,
		playerId: command.playerId,
		roundId: command.roundId,
		gameId: command.gameId,
		kind: command.kind,
		money: Money.create(command.amount),
		referenceExternalTransactionId:
			command.referenceExternalTransactionId ?? undefined,
	};
	WagerTransaction.validateInput(props);
	// Explicit allowlist and lexical key order; transport fields never enter business equality.
	const canonical = JSON.stringify({
		amount: props.money.toProps(),
		externalTransactionId: props.externalTransactionId,
		gameId: props.gameId,
		kind: props.kind,
		playerId: props.playerId,
		providerId: props.providerId,
		referenceExternalTransactionId:
			props.referenceExternalTransactionId ?? null,
		roundId: props.roundId,
	});
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	);
	const payloadHash = Array.from(new Uint8Array(digest), byte =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	return Object.freeze({ ...props, payloadHash });
}
