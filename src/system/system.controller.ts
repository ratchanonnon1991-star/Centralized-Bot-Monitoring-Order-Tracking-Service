import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BotsService } from '../bots/bots.service';
import { AuditService } from '../common/audit.service';
import { Actor, Auth } from '../common/auth';
import { NoNulChars } from '../common/validation';
import { DbService } from '../db/db.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { OrdersService } from '../orders/orders.service';
import { SystemService } from './system.service';

export class KillSwitchDto {
  /** true = stop the whole system (ปิดทั้งระบบ), false = resume (เปิดทั้งระบบ). */
  @IsBoolean()
  engaged!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @NoNulChars()
  reason?: string;
}

export class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @NoNulChars()
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @NoNulChars()
  targetId?: string;
}

@Controller('api')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly bots: BotsService,
    private readonly orders: OrdersService,
    private readonly deployments: DeploymentsService,
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  @Get('health')
  @Auth('public')
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true };
  }

  /** Everything the dashboard header + summary bar needs in one call. */
  @Get('overview')
  async overview() {
    const [killSwitch, bots, orders, latestDeployment] = await Promise.all([
      this.system.getKillSwitch(),
      this.bots.summary(),
      this.orders.countsByStatus(),
      this.deployments.latest(),
    ]);
    return { killSwitch, bots, orders, latestDeployment, serverTime: new Date() };
  }

  @Get('system/kill-switch')
  killSwitch() {
    return this.system.getKillSwitch();
  }

  /** PUT is naturally idempotent: setting the same state twice is a no-op (no second audit entry). */
  @Put('system/kill-switch')
  setKillSwitch(@Body() dto: KillSwitchDto, @Actor() actor: string) {
    return this.system.setKillSwitch(dto.engaged, dto.reason ?? null, actor);
  }

  @Get('audit-logs')
  auditLogs(@Query() q: AuditQueryDto) {
    return this.audit.list(q.limit, q.targetType, q.targetId);
  }
}
