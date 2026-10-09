import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BotsService } from '../bots/bots.service';
import { CommandsService } from '../bots/commands.service';
import { AgentRegistry } from '../common/agent-registry.service';
import { AppConfig } from '../config/app-config';
import { DbService } from '../db/db.service';
import { DispatchService } from '../orders/dispatch.service';

export interface TickReport {
  botsOffline: string[];
  ordersDelayed: number;
  ordersRequeuedOrFailed: number;
  ordersTimedOut: number;
  commandsExpired: number;
}

/**
 * Periodic sweep that turns silence into state:
 *   1. bot without heartbeat for HEARTBEAT_TIMEOUT_MS      -> offline (and its socket is closed)
 *   2. IN_PROGRESS order of an offline bot                 -> DELAYED
 *   3. DELAYED for longer than ORDER_REQUEUE_AFTER_MS      -> QUEUED (retry) or FAILED (no attempts left)
 *   4. IN_PROGRESS for longer than ORDER_MAX_PROCESSING_MS -> QUEUED / FAILED, and the bot is told to drop it
 *   5. command sent but not acknowledged in COMMAND_TIMEOUT_MS -> failed
 *
 * Every step locks the rows it changes (SKIP LOCKED), so running several server
 * instances - each with its own monitor - is safe.
 */
@Injectable()
export class HeartbeatMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly bots: BotsService,
    private readonly dispatch: DispatchService,
    private readonly commands: CommandsService,
    private readonly registry: AgentRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.config.backgroundJobs) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(`monitor tick failed: ${(err as Error).message}`));
    }, this.config.monitorIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<TickReport | null> {
    if (this.running) return null; // a slow tick must not overlap the next one
    this.running = true;
    try {
      const botsOffline = await this.bots.markStaleOffline(this.config.heartbeatTimeoutMs);
      for (const id of botsOffline) this.registry.disconnect(id, 4408, 'heartbeat timeout');

      const ordersDelayed = await this.dispatch.delayOrdersOfOfflineBots();
      const ordersRequeuedOrFailed = await this.dispatch.requeueExpiredDelayed(this.config.orderRequeueAfterMs);
      const revoked = await this.dispatch.requeueStuckInProgress(this.config.orderMaxProcessingMs);
      for (const { botId, orderId, attempt } of revoked) this.registry.send(botId, 'order.revoked', { orderId, attempt });
      const commandsExpired = await this.commands.expireRunning(this.config.commandTimeoutMs);
      await this.db.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);

      const ordersTimedOut = revoked.length;
      const report = { botsOffline, ordersDelayed, ordersRequeuedOrFailed, ordersTimedOut, commandsExpired };
      if (botsOffline.length || ordersDelayed || ordersRequeuedOrFailed || ordersTimedOut || commandsExpired) {
        this.logger.log(`monitor: ${JSON.stringify(report)}`);
      }
      return report;
    } finally {
      this.running = false;
    }
  }
}
