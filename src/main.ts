import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig } from './config/app-config';

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const config = app.get(AppConfig);
  await app.listen(config.port);
  Logger.log(`Dashboard  http://localhost:${config.port}`, 'Main');
  Logger.log(`Agent WS   ws://localhost:${config.port}/ws/agent`, 'Main');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
