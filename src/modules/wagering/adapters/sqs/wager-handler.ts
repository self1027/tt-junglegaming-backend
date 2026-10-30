import type { ProcessWagerUseCase } from '../../application/process-wager.use-case.js';
import { InboxPayloadConflict } from '../../public/inbox.js';
import { WagerApplicationError } from '../../public/process-wager.js';
import { PermanentMessageError } from '../../../../platform/messaging/transport.js';
import type {
	MessageOutcome,
	ReceivedMessage,
} from '../../../../platform/messaging/transport.js';
import { InvalidWagerMessage, parseWagerMessage } from './wager-message.js';

export function wagerHandler(
	useCase: ProcessWagerUseCase,
): (message: ReceivedMessage) => Promise<MessageOutcome> {
	return async message => {
		try {
			const { command, delivery } = await parseWagerMessage(message.body);
			const result = await useCase.execute(command, delivery);
			return {
				messageId: delivery.messageId,
				correlationId: result?.transactionId ?? delivery.messageId,
				providerId: command.providerId,
				walletId: result?.walletId ?? command.walletId,
				status: result?.status ?? 'DUPLICATE',
				...(result === undefined
					? {}
					: {
							transactionId: result.transactionId,
							correlationId: result.transactionId,
							idempotentReplay: result.idempotentReplay,
						}),
			};
		} catch (error) {
			if (
				error instanceof InvalidWagerMessage ||
				error instanceof InboxPayloadConflict
			)
				throw new PermanentMessageError(error.message);
			if (
				error instanceof WagerApplicationError &&
				error.code !== 'IDEMPOTENCY_IN_PROGRESS'
			)
				throw new PermanentMessageError(error.code);
			throw error;
		}
	};
}
