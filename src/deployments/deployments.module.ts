import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BotsModule } from '../bots/bots.module';
import { AppConfig } from '../config/app-config';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';

@Module({
  imports: [
    BotsModule,
    MulterModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        storage: memoryStorage(),
        limits: { fileSize: config.maxUploadBytes, files: 1 },
        // Browsers send the file name as raw UTF-8; multer's default latin1 turns Thai names into mojibake.
        defParamCharset: 'utf8',
      }),
    }),
  ],
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
