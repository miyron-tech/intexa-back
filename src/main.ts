import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get(ConfigService<Env, true>);

  // API вызывается сервером Next.js (BFF), который передаёт реальный IP клиента в X-Forwarded-For.
  // Доверяем заголовку только от loopback — в проде указать адрес/подсеть фронтенда.
  app.set('trust proxy', 'loopback');
  // Исходные фото приходят как data URL внутри JSON — стандартных 100 КБ не хватает
  app.useBodyParser('json', { limit: '25mb' });
  app.enableCors({
    origin: config.get('FRONTEND_URL', { infer: true }),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
