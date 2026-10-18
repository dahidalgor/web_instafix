import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';
import './config/environment';
import { isAllowedOrigin } from './config/environment';
import { checkDatabaseSchema } from './database/schema-check';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Caddy es el único proxy en producción; la API no expone un puerto público.
  if (process.env.NODE_ENV === 'production')
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableCors({
    origin: (origin: string | undefined, done: (error: Error | null, allow?: boolean) => void) =>
      done(null, !origin || isAllowedOrigin(origin)),
    credentials: true,
  });
  app.enableShutdownHooks();
  await checkDatabaseSchema();
  await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST || '127.0.0.1');
}
bootstrap().catch(() => {
  console.error('No se pudo iniciar la API');
  process.exit(1);
});
