import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Actor } from '../common/auth';
import { Idempotent } from '../common/idempotency.interceptor';
import { BotIdParam } from '../common/validation';
import { BotsService } from './bots.service';
import { CommandsService } from './commands.service';

/** 'update' is not here: it needs a package, so it goes through POST /api/deployments/:id/rollout. */
const DIRECT_COMMANDS = ['start', 'stop', 'restart', 'status'] as const;

export class SendCommandDto {
  @IsIn(DIRECT_COMMANDS)
  command!: (typeof DIRECT_COMMANDS)[number];
}

export class LimitQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 50;
}

@Controller('api/bots')
export class BotsController {
  constructor(
    private readonly bots: BotsService,
    private readonly commands: CommandsService,
  ) {}

  @Get()
  list() {
    return this.bots.list();
  }

  @Get(':id')
  get(@BotIdParam() id: string) {
    return this.bots.get(id);
  }

  /** start = เปิดบอท (accept orders), stop = ปิดบอท, restart, status. */
  @Post(':id/commands')
  @Idempotent({ required: false })
  sendCommand(@BotIdParam() id: string, @Body() dto: SendCommandDto, @Actor() actor: string) {
    return this.commands.create(id, dto.command, null, actor);
  }

  @Get(':id/commands')
  async listCommands(@BotIdParam() id: string, @Query() q: LimitQueryDto) {
    if (!(await this.bots.exists(id))) throw new NotFoundException({ error: 'BOT_NOT_FOUND' });
    return this.commands.list(id, q.limit);
  }

  @Get(':id/logs')
  logs(@BotIdParam() id: string, @Query() q: LimitQueryDto) {
    return this.bots.logs(id, q.limit);
  }
}
