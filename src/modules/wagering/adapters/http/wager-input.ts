import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import {
	moneyInput,
	objectInput,
	textInput,
	uuidInput,
} from '../../../../platform/http/input.js';
import { Money } from '../../../financial/public/index.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WagerTransactionKind } from '../../domain/wager-types.js';
import type {
	ProcessWagerCommand,
	ProcessWagerResult,
} from '../../public/process-wager.js';

export class WagerBodyPipe implements PipeTransform<
	unknown,
	Omit<ProcessWagerCommand, 'idempotencyKey'>
> {
	transform(value: unknown): Omit<ProcessWagerCommand, 'idempotencyKey'> {
		const data = objectInput(value, [
			'providerId',
			'externalTransactionId',
			'walletId',
			'playerId',
			'roundId',
			'gameId',
			'kind',
			'money',
			'referenceExternalTransactionId',
		]);
		const command = {
			providerId: textInput(data.providerId),
			externalTransactionId: textInput(data.externalTransactionId),
			walletId: uuidInput(data.walletId),
			playerId: textInput(data.playerId),
			roundId: textInput(data.roundId),
			gameId: textInput(data.gameId),
			kind: textInput(data.kind),
			amount: moneyInput(data.money),
			referenceExternalTransactionId:
				data.referenceExternalTransactionId == null
					? undefined
					: textInput(data.referenceExternalTransactionId),
		};
		try {
			WagerTransaction.validateInput({
				...command,
				kind: command.kind as WagerTransactionKind,
				money: Money.create(command.amount),
				idempotencyKey: 'http-validation',
			});
		} catch {
			throw new BadRequestException('Invalid wager');
		}
		return { ...command, kind: command.kind as WagerTransactionKind };
	}
}

export function wagerResponse(
	result: ProcessWagerResult,
	response: { status(code: number): unknown },
): ProcessWagerResult {
	switch (result.status) {
		case 'PROCESSED':
			response.status(200);
			break;
		case 'PENDING':
		case 'PENDING_REFERENCE':
			response.status(202);
			break;
		case 'REJECTED':
			response.status(422);
			break;
		case 'FAILED':
			response.status(500);
			break;
	}
	return result;
}
