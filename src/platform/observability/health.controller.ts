import { Controller, Get, Inject, Res } from '@nestjs/common';
import { READINESS, readinessResponse } from './readiness.js';
import type { Readiness, ReadinessResult } from './readiness.js';

@Controller('health')
export class HealthController {
	constructor(@Inject(READINESS) private readonly readiness: Readiness) {}

	@Get('live')
	live(): { status: 'ok' } {
		return { status: 'ok' };
	}

	@Get('ready')
	ready(
		@Res({ passthrough: true }) response: { status(code: number): unknown },
	): Promise<ReadinessResult> {
		return readinessResponse(this.readiness, response);
	}
}
