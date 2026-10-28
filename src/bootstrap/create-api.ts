import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module.js';

export async function createApi(): Promise<INestApplication> {
	return NestFactory.create(ApiModule);
}
