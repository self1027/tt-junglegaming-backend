import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import {
	moneyInput,
	objectInput,
	textInput,
} from '../../../../platform/http/input.js';
import { Money } from '../../domain/money.js';
import type { CreateWalletCommand } from '../../public/wallet-api.js';

export class CreateWalletPipe implements PipeTransform<
	unknown,
	CreateWalletCommand
> {
	transform(value: unknown): CreateWalletCommand {
		const data = objectInput(value, ['playerId', 'initialBalance']);
		const playerId = textInput(data.playerId);
		const initialBalance = moneyInput(data.initialBalance);
		try {
			Money.create(initialBalance);
		} catch {
			throw new BadRequestException('Invalid initialBalance');
		}
		return { playerId, initialBalance };
	}
}
