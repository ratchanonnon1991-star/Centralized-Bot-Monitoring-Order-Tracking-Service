import { Injectable, NotFoundException } from '@nestjs/common';
import { AgentRegistry } from '../common/agent-registry.service';
import { EventsService } from '../common/events.service';
import { DbService } from '../db/db.service';
import { ACTIVE_STATUSES } from '../orders/order-state';
import { SystemService } from '../system/system.service';

/**
 * What a bot is doing right now, as shown on its card.
 *  OFFLINE     - no heartbeat within the timeout
 *  DISABLED    - operator turned this bot off ("ปิดบอท")
 *  PAUSED      - global kill-switch engaged
 *  STANDBY     - online, enabled, idle, waiting for an order
 *  IN_PROGRESS - working on an order
 */
export type BotState = 'OFFLINE' | 'DISABLED' | 'PAUSED' | 'STANDBY' | 'IN_PROGRESS';

export interface HeartbeatInput {
  cpuPercent: number;
  memoryPercent: number;
  uptimeSeconds: number;
  /** Version actually installed on the machine; corrects code_version if an update ack was lost. */
  codeVersion?: string | null;
}

export interface ConnectInput {
  hostName: string | null;
  codeVersion: string | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const BOT_SELECT = `
  SELECT b.*, o.id AS order_id, o.external_order_id, o.status AS order_status,
         o.attempt_count AS order_attempt, o.product AS order_product, o.started_at AS order_started_at
    FROM oxide_bot_agents b
    LEFT JOIN orders o ON o.assigned_bot_id = b.id AND o.status = ANY($1::text[])`;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

@Injectable()
export class BotsService {
  constructor(
    private readonly db: DbService,
    private readonly system: SystemService,
    private readonly registry: AgentRegistry,
    private readonly events: EventsService,
  ) {}

  async list() {
    const [rows, ks] = await Promise.all([
      this.db.query(`${BOT_SELECT} ORDER BY b.id`, [ACTIVE_STATUSES]),
      this.system.getKillSwitch(),
    ]);
    return rows.map((r) => this.toView(r, ks.engaged));
  }

  async get(botId: string) {
    const [rows, ks] = await Promise.all([
      this.db.query(`${BOT_SELECT} WHERE b.id = $2`, [ACTIVE_STATUSES, botId]),
      this.system.getKillSwitch(),
    ]);
    if (!rows[0]) throw new NotFoundException({ error: 'BOT_NOT_FOUND' });
    const stats = await this.db.query(
      `SELECT count(*) FILTER (WHERE event_type = 'STATUS_CHANGED' AND payload->>'to' = 'COMPLETED') AS done,
              count(*) FILTER (WHERE event_type = 'STATUS_CHANGED' AND payload->>'reason' IN ('BOT_REPORTED_FAILURE','MAX_ATTEMPTS_REACHED')) AS failed
         FROM order_events
        WHERE payload->>'botId' = $1 AND created_at > now() - interval '24 hours'`,
      [botId],
    );
    return {
      ...this.toView(rows[0], ks.engaged),
      stats24h: { done: Number(stats[0].done), failed: Number(stats[0].failed) },
    };
  }

  async exists(botId: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT 1 FROM oxide_bot_agents WHERE id = $1`, [botId]);
    return rows.length > 0;
  }

  async isEnabled(botId: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT enabled FROM oxide_bot_agents WHERE id = $1`, [botId]);
    return rows[0]?.enabled === true;
  }

  async summary() {
    const [rows, ks] = await Promise.all([
      this.db.query(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE b.status = 'online') AS online,
                count(*) FILTER (WHERE b.status = 'online' AND b.enabled) AS enabled_online,
                count(*) FILTER (WHERE b.status = 'online' AND b.enabled AND NOT busy) AS idle,
                count(*) FILTER (WHERE b.status = 'online' AND busy) AS in_progress
           FROM (SELECT b.*, EXISTS (SELECT 1 FROM orders o WHERE o.assigned_bot_id = b.id AND o.status = ANY($1::text[])) AS busy
                   FROM oxide_bot_agents b) b`,
        [ACTIVE_STATUSES],
      ),
      this.system.getKillSwitch(),
    ]);
    const r = rows[0];
    // Under the kill-switch nobody is accepting work, so Active/Standby drop to 0.
    return {
      total: Number(r.total),
      online: Number(r.online),
      active: ks.engaged ? 0 : Number(r.enabled_online),
      standby: ks.engaged ? 0 : Number(r.idle),
      inProgress: Number(r.in_progress),
    };
  }

  async recordConnect(botId: string, input: ConnectInput): Promise<void> {
    await this.db.query(
      `UPDATE oxide_bot_agents
          SET status = 'online', connected_at = now(), last_heartbeat = now(), updated_at = now(),
              host_name = COALESCE($2, host_name), code_version = COALESCE($3, code_version)
        WHERE id = $1`,
      [botId, input.hostName, input.codeVersion],
    );
    await this.addLog(botId, 'info', `agent connected${input.hostName ? ` from ${input.hostName}` : ''}`);
    this.events.emit('changed', 'bots');
  }

  async recordHeartbeat(botId: string, hb: HeartbeatInput): Promise<void> {
    await this.db.query(
      `UPDATE oxide_bot_agents
          SET status = 'online', last_heartbeat = now(), updated_at = now(),
              cpu_percent = $2, memory_percent = $3, uptime_seconds = $4,
              code_version = COALESCE($5, code_version)
        WHERE id = $1`,
      [
        botId,
        clamp(hb.cpuPercent, 0, 100),
        clamp(hb.memoryPercent, 0, 100),
        Math.max(0, Math.floor(hb.uptimeSeconds)),
        hb.codeVersion ?? null,
      ],
    );
    this.events.emit('changed', 'bots');
  }

  /** The socket closed: the bot is gone now, no need to wait for the heartbeat timeout. */
  async recordDisconnect(botId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE oxide_bot_agents SET status = 'offline', cpu_percent = 0, memory_percent = 0, updated_at = now() WHERE id = $1`,
      [botId],
    );
    await this.addLog(botId, 'warn', `agent disconnected (${reason})`);
    this.events.emit('changed', 'bots');
  }

  /** Bots whose last heartbeat is older than the timeout go offline. Returns their ids. */
  async markStaleOffline(timeoutMs: number): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE oxide_bot_agents
          SET status = 'offline', cpu_percent = 0, memory_percent = 0, updated_at = now()
        WHERE status <> 'offline'
          AND (last_heartbeat IS NULL OR last_heartbeat < now() - ($1 || ' milliseconds')::interval)
        RETURNING id`,
      [String(timeoutMs)],
    );
    for (const { id } of rows) await this.addLog(id, 'error', `heartbeat timeout (> ${timeoutMs} ms) - marked offline`);
    if (rows.length) this.events.emit('changed', 'bots');
    return rows.map((r) => r.id);
  }

  async addLog(botId: string, level: LogLevel, message: string): Promise<void> {
    await this.db.query(`INSERT INTO bot_logs (bot_id, level, message) VALUES ($1, $2, $3)`, [
      botId,
      level,
      message.slice(0, 2000),
    ]);
  }

  async logs(botId: string, limit: number) {
    if (!(await this.exists(botId))) throw new NotFoundException({ error: 'BOT_NOT_FOUND' });
    const rows = await this.db.query(
      `SELECT id, level, message, created_at FROM bot_logs WHERE bot_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [botId, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), level: r.level, message: r.message, createdAt: r.created_at }));
  }

  private toView(r: Record<string, any>, killSwitch: boolean) {
    const online = r.status === 'online';
    const busy = r.order_id !== null;
    const state: BotState = !online
      ? 'OFFLINE'
      : busy
        ? 'IN_PROGRESS'
        : !r.enabled
          ? 'DISABLED'
          : killSwitch
            ? 'PAUSED'
            : 'STANDBY';
    return {
      id: r.id as string,
      name: r.name as string,
      deviceName: r.device_name as string,
      hostName: r.host_name as string | null,
      status: r.status as string,
      connected: this.registry.isConnected(r.id),
      enabled: r.enabled as boolean,
      state,
      lastHeartbeat: r.last_heartbeat as Date | null,
      metrics: {
        cpuPercent: Number(r.cpu_percent),
        memoryPercent: Number(r.memory_percent),
        uptimeSeconds: Number(r.uptime_seconds),
      },
      codeVersion: r.code_version as string | null,
      currentOrder: busy
        ? {
            id: Number(r.order_id),
            externalOrderId: r.external_order_id as string,
            status: r.order_status as string,
            attempt: r.order_attempt as number,
            product: r.order_product as string | null,
            startedAt: r.order_started_at as Date | null,
          }
        : null,
      lastResult: r.last_result
        ? { result: r.last_result as 'done' | 'failed', summary: r.last_result_summary as string, at: r.last_result_at }
        : null,
    };
  }
}
