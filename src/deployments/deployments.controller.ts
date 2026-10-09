import {
  BadRequestException,
  Body,
  Controller,
  Get,
  GoneException,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches } from 'class-validator';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { Actor, Auth } from '../common/auth';
import { Idempotent } from '../common/idempotency.interceptor';
import { BOT_ID_PATTERN, IdParam } from '../common/validation';
import { DeploymentsService, exists } from './deployments.service';

export class RolloutDto {
  /** Omit to update every bot. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(BOT_ID_PATTERN, { each: true, message: 'each botId must be 1-64 chars of [A-Za-z0-9_-]' })
  botIds?: string[];
}

@Controller('api/deployments')
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  /** multipart/form-data with a `file` field containing the .zip package. */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Actor() actor: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!file) throw new BadRequestException({ error: 'FILE_REQUIRED', message: 'Send the package in a "file" field' });
    const { deployment, created } = await this.deployments.upload(file.originalname, file.buffer, actor);
    res.status(created ? 201 : 200);
    return { ...deployment, created };
  }

  @Get()
  list() {
    return this.deployments.list();
  }

  @Post(':id/rollout')
  @Idempotent({ required: false })
  rollout(@IdParam() id: number, @Body() dto: RolloutDto, @Actor() actor: string) {
    return this.deployments.rollout(id, dto.botIds, actor);
  }

  /** Agents download the package with their own token. */
  @Get(':id/download')
  @Auth('agent-or-admin')
  async download(@IdParam() id: number, @Res({ passthrough: true }) res: Response) {
    const d = await this.deployments.get(id);
    if (!(await exists(d.storagePath))) {
      throw new GoneException({
        error: 'PACKAGE_FILE_MISSING',
        message: 'The package file is gone from storage - upload the same .zip again to restore it',
      });
    }
    res.setHeader('X-Checksum-SHA256', d.sha256);
    return new StreamableFile(createReadStream(d.storagePath), {
      type: 'application/zip',
      disposition: `attachment; filename="${d.version}.zip"`,
      length: d.sizeBytes,
    });
  }
}
