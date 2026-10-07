import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';
import './config/environment';
import { allowedOrigins } from './config/environment';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Caddy es el único proxy en producción; la API no expone un puerto público.
  if (process.env.NODE_ENV === 'production')
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableCors({ origin: allowedOrigins(), credentials: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST || '127.0.0.1');
}
bootstrap().catch(() => {
  console.error('No se pudo iniciar la API');
  process.exit(1);
});
