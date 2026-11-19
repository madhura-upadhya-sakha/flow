import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '2mb' });
  app.enableCors({ origin: config.get<string>('WEB_ORIGIN', 'http://localhost:5173') });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));

  const port = Number(config.get<string>('PORT', '3000'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const localDashboard = process.env.NODE_ENV !== 'production' && config.get('LOCAL_DASHBOARD_WORKSPACE_ID');
  await app.listen(port, localDashboard ? '127.0.0.1' : '0.0.0.0');
}

void bootstrap();
