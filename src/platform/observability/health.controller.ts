import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { READINESS } from './readiness.js';
import type { Readiness, ReadinessResult } from './readiness.js';

@Controller('health')
export class HealthController {
	constructor(@Inject(READINESS) private readonly readiness: Readiness) {}

	@Get('live')
	live(): { status: 'ok' } {
		return { status: 'ok' };
	}

	@Get('ready')
	@HttpCode(503)
	ready(): Promise<ReadinessResult> {
		return this.readiness.check();
	}
}
