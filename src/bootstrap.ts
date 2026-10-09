import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { join } from 'node:path';

// pnpm scripts run from the project root, in dev (dist/) and in tests (ts-jest) alike.
const PUBLIC_DIR = join(process.cwd(), 'public');

/** Shared by main.ts and the e2e tests so both run the exact same app setup. */
export function configureApp(app: INestApplication): void {
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  (app as NestExpressApplication).useStaticAssets(PUBLIC_DIR);
  app.enableShutdownHooks();
}
