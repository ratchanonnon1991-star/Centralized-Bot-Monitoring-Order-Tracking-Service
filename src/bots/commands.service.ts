import { Injectable, NotFoundException } from '@nestjs/common';
import { AgentRegistry } from '../common/agent-registry.service';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../common/events.service';
import { DbService } from '../db/db.service';
import { SIMULATOR_COMMANDS, SimulatorClient } from './simulator.client';

export const BOT_COMMANDS = ['start', 'stop', 'restart', 'status', 'update'] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];

interface CommandRow {
  id: string;
  bot_id: string;
  command: BotCommand;
  requested_by: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  payload: Record<string, unknown> | null;
  result: unknown;
  transport: 'agent' | 'simulator' | null;
  delivery_attempts: number;
  created_at: Date;
  dispatched_at: Date | null;
  completed_at: Date | null;
}

export function toCommandDto(r: CommandRow) {
  return {
    id: Number(r.id),
    botId: r.bot_id,
    command: r.command,
    requestedBy: r.requested_by,
    status: r.status,
    payload: r.payload,
    result: r.result,
    transport: r.transport,
    deliveryAttempts: r.delivery_attempts,
    createdAt: r.created_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
  };
}
export type CommandDto = ReturnType<typeof toCommandDto>;

/**
 * Commands sent to a bot. Lifecycle: queued -> running (sent to the agent) -> success | failed.
 *
 * Delivery is at-least-once: queued and running commands are re-sent when the agent reconnects,
 * and the agent de-duplicates by command id. Results are applied with a status guard, so a
 * repeated ack changes nothing. A bot without a live agent falls back to the pack's simulator.
 */
@Injectable()
export class CommandsService {
  constructor(
    private readonly db: DbService,
    private readonly registry: AgentRegistry,
    private readonly simulator: SimulatorClient,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async create(
    botId: string,
    command: BotCommand,
    payload: Record<string, unknown> | null,
    actor: string,
  ): Promise<CommandDto> {
    return (await this.createUnlessOpen(botId, command, payload, actor, null)).command;
  }

  /**
   * Like create(), but when an open (queued/running) command of the same kind whose
   * payload[dedupeKey] matches already exists, returns that one instead (created=false).
   * The check runs under the bot row lock, so concurrent callers cannot both create.
   */
  async createUnlessOpen(
    botId: string,
    command: BotCommand,
    payload: Record<string, unknown> | null,
    actor: string,
    dedupeKey: string | null,
  ): Promise<{ command: CommandDto; created: boolean }> {
    const { row, created } = await this.db.tx(async (c) => {
      const { rows: bots } = await c.query(`SELECT id FROM oxide_bot_agents WHERE id = $1 FOR UPDATE`, [botId]);
      if (!bots[0]) throw new NotFoundException({ error: 'BOT_NOT_FOUND' });

      if (dedupeKey !== null) {
        const { rows: open } = await c.query<CommandRow>(
          `SELECT * FROM oxide_bot_commands
            WHERE bot_id = $1 AND command = $2 AND status IN ('queued','running') AND payload->>$3 = $4
            ORDER BY id DESC LIMIT 1`,
          [botId, command, dedupeKey, String(payload?.[dedupeKey])],
        );
        if (open[0]) return { row: open[0], created: false };
      }

      // start/stop change the desired state immediately: dispatch reads `enabled`, so a stopped
      // bot gets no new order even if its agent is offline and has not seen the command yet.
      if (command === 'start' || command === 'stop') {
        await c.query(`UPDATE oxide_bot_agents SET enabled = $2, updated_at = now() WHERE id = $1`, [
          botId,
          command === 'start',
        ]);
      }
      const { rows } = await c.query<CommandRow>(
        `INSERT INTO oxide_bot_commands (bot_id, command, requested_by, payload) VALUES ($1, $2, $3, $4) RETURNING *`,
        [botId, command, actor, payload],
      );
      await this.audit.log(c, {
        actor,
        action: `BOT_COMMAND_${command.toUpperCase()}`,
        targetType: 'bot',
        targetId: botId,
        metadata: { commandId: Number(rows[0].id), payload },
      });
      if (command === 'update') {
        // Only the newest update counts: an older package still pending must not be installed
        // after (or at the same time as) this one.
        await c.query(
          `UPDATE oxide_bot_commands
              SET status = 'failed', completed_at = now(), result = $3
            WHERE bot_id = $1 AND command = 'update' AND status IN ('queued','running') AND id <> $2`,
          [botId, rows[0].id, JSON.stringify({ error: 'SUPERSEDED', supersededBy: Number(rows[0].id) })],
        );
      }
      return { row: rows[0], created: true };
    });

    if (!created) return { command: toCommandDto(row), created };
    this.events.emit('changed', 'bots');
    if (command === 'start') this.events.emit('orderQueued');
    return { command: toCommandDto(await this.deliver(row)), created };
  }

  /** Re-sends everything not yet acknowledged. Called when an agent says hello. */
  async deliverPending(botId: string): Promise<void> {
    const rows = await this.db.query<CommandRow>(
      `SELECT * FROM oxide_bot_commands WHERE bot_id = $1 AND status IN ('queued','running') ORDER BY id`,
      [botId],
    );
    for (const row of rows) await this.sendToAgent(row);
  }

  /** Agent acknowledged a command. Duplicate acks are ignored. */
  async handleResult(botId: string, commandId: number, ok: boolean, result: unknown): Promise<boolean> {
    const updated = await this.db.tx(async (c) => {
      const { rows } = await c.query<CommandRow>(
        `UPDATE oxide_bot_commands SET status = $3, result = $4, completed_at = now()
          WHERE id = $1 AND bot_id = $2 AND status IN ('queued','running')
          RETURNING *`,
        [commandId, botId, ok ? 'success' : 'failed', JSON.stringify(result ?? null)],
      );
      const row = rows[0];
      if (row && ok && row.command === 'update' && typeof row.payload?.version === 'string') {
        await c.query(`UPDATE oxide_bot_agents SET code_version = $2, updated_at = now() WHERE id = $1`, [
          botId,
          row.payload.version,
        ]);
      }
      return row;
    });
    if (updated) this.events.emit('changed', 'commands');
    if (updated?.command === 'update') this.events.emit('changed', 'bots');
    return !!updated;
  }

  /**
   * The agent still holds these commands (an update deferred until the current order ends, or a
   * download in progress): restart their timeout so expireRunning does not fail them meanwhile.
   */
  async keepAlive(botId: string, commandIds: number[]): Promise<void> {
    if (!commandIds.length) return;
    await this.db.query(
      `UPDATE oxide_bot_commands SET dispatched_at = now()
        WHERE bot_id = $1 AND id = ANY($2::bigint[]) AND status = 'running'`,
      [botId, commandIds],
    );
  }

  /** Commands an agent took but never answered (and stopped reporting as held) are failed after the timeout. */
  async expireRunning(timeoutMs: number): Promise<number> {
    const rows = await this.db.query(
      `UPDATE oxide_bot_commands
          SET status = 'failed', completed_at = now(), result = '{"error":"TIMEOUT"}'
        WHERE status = 'running' AND dispatched_at < now() - ($1 || ' milliseconds')::interval
        RETURNING id`,
      [String(timeoutMs)],
    );
    if (rows.length) this.events.emit('changed', 'commands');
    return rows.length;
  }

  async list(botId: string, limit: number): Promise<CommandDto[]> {
    const rows = await this.db.query<CommandRow>(
      `SELECT * FROM oxide_bot_commands WHERE bot_id = $1 ORDER BY id DESC LIMIT $2`,
      [botId, limit],
    );
    return rows.map(toCommandDto);
  }

  private async deliver(row: CommandRow): Promise<CommandRow> {
    if (await this.sendToAgent(row)) return (await this.reload(row.id)) ?? row;

    if (this.simulator.enabled && (SIMULATOR_COMMANDS as readonly string[]).includes(row.command)) {
      const res = await this.simulator.sendCommand(row.bot_id, row.command);
      const { rows } = await this.db.pool.query<CommandRow>(
        `UPDATE oxide_bot_commands
            SET status = $2, result = $3, transport = 'simulator', dispatched_at = now(), completed_at = now(),
                delivery_attempts = delivery_attempts + 1
          WHERE id = $1 AND status = 'queued'
          RETURNING *`,
        [row.id, res.ok ? 'success' : 'failed', JSON.stringify(res.ok ? res.body : { error: res.error })],
      );
      this.events.emit('changed', 'commands');
      return rows[0] ?? row;
    }
    // Neither transport available: stays queued and is delivered when the agent connects.
    return row;
  }

  private async sendToAgent(row: CommandRow): Promise<boolean> {
    const sent = this.registry.send(row.bot_id, 'command', {
      commandId: Number(row.id),
      command: row.command,
      payload: row.payload,
    });
    if (!sent) return false;
    await this.db.query(
      `UPDATE oxide_bot_commands
          SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
              transport = 'agent', dispatched_at = now(), delivery_attempts = delivery_attempts + 1
        WHERE id = $1 AND status IN ('queued','running')`,
      [row.id],
    );
    this.events.emit('changed', 'commands');
    return true;
  }

  private async reload(id: string): Promise<CommandRow | null> {
    const rows = await this.db.query<CommandRow>(`SELECT * FROM oxide_bot_commands WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
}
