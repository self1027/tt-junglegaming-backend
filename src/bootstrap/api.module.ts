import { Module } from '@nestjs/common';
import { HealthController } from '../platform/observability/health.controller.js';

@Module({ controllers: [HealthController] })
export class ApiModule {}
