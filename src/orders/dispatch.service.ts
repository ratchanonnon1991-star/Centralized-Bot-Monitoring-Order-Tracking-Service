import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { EventsService } from '../common/events.service';
import { AppConfig } from '../config/app-config';
import { DbService, Queryable } from '../db/db.service';
import { SystemService } from '../system/system.service';
import { ACTIVE_STATUSES, retryDelayMs } from './order-state';
import { OrderDto, OrderRepository, OrderRow, Sql, toOrderDto } from './order.repository';

export type NoClaimReason = 'KILL_SWITCH' | 'BOT_NOT_FOUND' | 'BOT_DISABLED' | 'BOT_OFFLINE' | 'BOT_BUSY' | 'NO_ORDER';
export type ClaimResult = { order: OrderDto } | { order: null; reason: NoClaimReason };

export interface ReportResult {
  ok: boolean;
  duplicate?: boolean;
  reason?: 'ORDER_NOT_FOUND' | 'STALE_ATTEMPT';
  order?: OrderDto;
}

export interface ReportedWork {
  orderId: number;
  attempt: number;
}

export interface RevokedWork extends ReportedWork {
  botId: string;
}

/**
 * Reasons for which the system - not the bot - ended an attempt. A success report for such an
 * attempt is still accepted while nobody has re-claimed the order: the top-up did happen, and
 * running it again on another bot would deliver it twice.
 */
const SYSTEM_ENDED_ATTEMPT = ['DELAY_EXPIRED', 'AGENT_LOST_WORK', 'PROCESSING_TIMEOUT', 'MAX_ATTEMPTS_REACHED'];
const BOT_FAILURE_REASONS = ['BOT_REPORTED_FAILURE', 'MAX_ATTEMPTS_REACHED'];

/**
 * Everything between "an order is QUEUED" and "the order is finished":
 * claiming, completion/failure reports, retry with backoff, and reconnect reconciliation.
 * Every method is one transaction; ordering between racing actors is decided by row locks.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly db: DbService,
    private readonly repo: OrderRepository,
    private readonly system: SystemService,
    private readonly events: EventsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * A bot asks for work. Concurrency guarantees:
   *  - kill-switch row is share-locked: a flip waits for us, and we never claim after a flip commits;
   *  - the bot row is locked: one bot cannot claim twice in parallel;
   *  - the order row is taken with SKIP LOCKED: two bots never get the same order and never block each other;
   *  - uq_orders_one_active_per_bot backs this up at the schema level.
   */
  async claimNext(botId: string): Promise<ClaimResult> {
    const result = await this.db.tx<ClaimResult>(async (c) => {
      if ((await this.system.getKillSwitch(c, 'share')).engaged) return { order: null, reason: 'KILL_SWITCH' };

      const { rows: bots } = await c.query(`SELECT enabled, status FROM oxide_bot_agents WHERE id = $1 FOR UPDATE`, [
        botId,
      ]);
      const bot = bots[0];
      if (!bot) return { order: null, reason: 'BOT_NOT_FOUND' };
      if (!bot.enabled) return { order: null, reason: 'BOT_DISABLED' };
      if (bot.status !== 'online') return { order: null, reason: 'BOT_OFFLINE' };

      const { rows: busy } = await c.query(
        `SELECT 1 FROM orders WHERE assigned_bot_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
        [botId, ACTIVE_STATUSES],
      );
      if (busy.length) return { order: null, reason: 'BOT_BUSY' };

      // A retry is not handed straight back to the bot whose attempt just failed or hung:
      // other bots get RETRY_SAME_BOT_AFTER_MS to pick it up first.
      const { rows: next } = await c.query(
        `SELECT id FROM orders
          WHERE status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            AND (last_bot_id IS DISTINCT FROM $1
                 OR COALESCE(next_attempt_at, updated_at) <= now() - ($2 || ' milliseconds')::interval)
          ORDER BY created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [botId, String(this.config.retrySameBotAfterMs)],
      );
      if (!next.length) return { order: null, reason: 'NO_ORDER' };

      const order = await this.repo.transition(c, {
        orderId: next[0].id,
        from: ['QUEUED'],
        to: 'IN_PROGRESS',
        set: {
          assigned_bot_id: botId,
          attempt_count: new Sql('attempt_count + 1'),
          started_at: Sql.NOW,
          next_attempt_at: null,
          delayed_at: null,
        },
        actor: `bot:${botId}`,
        reason: 'CLAIMED',
      });
      // We hold the row lock from SKIP LOCKED, so the transition cannot lose a race here.
      if (!order) throw new Error(`order ${next[0].id} changed while locked`);
      return { order: toOrderDto(order) };
    });

    if (result.order) this.changed();
    return result;
  }

  /**
   * Bot reports success. Safe to call any number of times (duplicates are acknowledged, not re-applied).
   * A late report for an attempt the system already gave up on is accepted if nobody re-claimed the order.
   */
  async complete(botId: string, work: ReportedWork, result: unknown): Promise<ReportResult> {
    const outcome = await this.db.tx<ReportResult>(async (c) => {
      const order =
        (await this.repo.transition(c, {
          orderId: work.orderId,
          from: ACTIVE_STATUSES,
          to: 'COMPLETED',
          set: { completed_at: Sql.NOW, delayed_at: null, last_error: null, result: result ?? null },
          guard: { botId, attempt: work.attempt },
          actor: `bot:${botId}`,
          reason: 'BOT_REPORTED_DONE',
        })) ?? (await this.completeLate(c, botId, work, result));
      if (order) {
        await this.setBotResult(c, botId, 'done', summarize(order, 'done'));
        return { ok: true, duplicate: false, order: toOrderDto(order) };
      }
      return this.explainRejectedReport(c, botId, work, 'COMPLETED');
    });
    if (outcome.ok && !outcome.duplicate) this.changed();
    return outcome;
  }

  /** Bot reports failure. Retryable failures go back to the queue with exponential backoff until attempts run out. */
  async fail(botId: string, work: ReportedWork, error: string, retryable: boolean): Promise<ReportResult> {
    const outcome = await this.db.tx<ReportResult>(async (c) => {
      const current = await this.repo.findById(c, work.orderId, true);
      const held =
        current &&
        ACTIVE_STATUSES.includes(current.status) &&
        current.assigned_bot_id === botId &&
        current.attempt_count === work.attempt;
      if (!held) {
        // The same failure re-sent (the ack was lost): acknowledge it like a duplicate completion.
        const ended = current && (await this.attemptEnd(c, work));
        const sameFailure =
          ended?.botId === botId && ended.actor === `bot:${botId}` && BOT_FAILURE_REASONS.includes(ended.reason);
        if (current && sameFailure) return { ok: true, duplicate: true, order: toOrderDto(current) };
        return this.explainRejectedReport(c, botId, work, null);
      }

      const order = await this.retryOrFail(c, current, {
        error,
        retryable,
        actor: `bot:${botId}`,
        reason: 'BOT_REPORTED_FAILURE',
      });
      await this.setBotResult(c, botId, 'failed', `${current.external_order_id}: ${error}`);
      return { ok: true, duplicate: false, order: toOrderDto(order) };
    });
    if (outcome.ok && !outcome.duplicate) {
      this.changed();
      if (outcome.order?.status === 'QUEUED') this.events.emit('orderQueued');
    }
    return outcome;
  }

  /**
   * Send an active order back to the queue (with backoff) or, when no attempts are left
   * or the error is not retryable, to FAILED. Caller must hold the order row lock, and emits
   * `orderQueued` itself after its transaction commits.
   */
  async retryOrFail(
    c: PoolClient,
    order: OrderRow,
    opts: { error: string; retryable: boolean; actor: string; reason: string },
  ): Promise<OrderRow> {
    const guard = { botId: order.assigned_bot_id ?? undefined, attempt: order.attempt_count };
    const canRetry = opts.retryable && order.attempt_count < order.max_attempts;
    const next = canRetry
      ? await this.repo.transition(c, {
          orderId: order.id,
          from: [order.status],
          to: 'QUEUED',
          set: {
            assigned_bot_id: null,
            last_bot_id: order.assigned_bot_id,
            next_attempt_at: Sql.afterMs(retryDelayMs(order.attempt_count, this.config.retryBaseDelayMs)),
            started_at: null,
            delayed_at: null,
            last_error: opts.error,
          },
          guard,
          actor: opts.actor,
          reason: opts.reason,
          meta: { error: opts.error, retryInMs: retryDelayMs(order.attempt_count, this.config.retryBaseDelayMs) },
        })
      : await this.repo.transition(c, {
          orderId: order.id,
          from: [order.status],
          to: 'FAILED',
          set: { delayed_at: null, last_error: opts.error },
          guard,
          actor: opts.actor,
          reason: opts.retryable ? 'MAX_ATTEMPTS_REACHED' : opts.reason,
          meta: { error: opts.error },
        });
    if (!next) throw new Error(`order ${order.id} changed while locked`);
    return next;
  }

  /** IN_PROGRESS orders whose bot went offline become DELAYED. The bot may still come back and finish them. */
  async delayOrdersOfOfflineBots(): Promise<number> {
    const n = await this.db.tx(async (c) => {
      const { rows } = await c.query<OrderRow>(
        `SELECT o.* FROM orders o
           JOIN oxide_bot_agents b ON b.id = o.assigned_bot_id
          WHERE o.status = 'IN_PROGRESS' AND b.status = 'offline'
          FOR UPDATE OF o SKIP LOCKED`,
      );
      for (const o of rows) {
        await this.repo.transition(c, {
          orderId: o.id,
          from: ['IN_PROGRESS'],
          to: 'DELAYED',
          set: { delayed_at: Sql.NOW },
          guard: { botId: o.assigned_bot_id!, attempt: o.attempt_count },
          actor: 'system',
          reason: 'HEARTBEAT_TIMEOUT',
        });
      }
      return rows.length;
    });
    if (n) this.changed();
    return n;
  }

  /** DELAYED for too long: give up on that bot and retry elsewhere, or fail when attempts are used up. */
  async requeueExpiredDelayed(afterMs: number): Promise<number> {
    const { n, queued } = await this.db.tx(async (c) => {
      const { rows } = await c.query<OrderRow>(
        `SELECT * FROM orders
          WHERE status = 'DELAYED' AND delayed_at < now() - ($1 || ' milliseconds')::interval
          FOR UPDATE SKIP LOCKED`,
        [String(afterMs)],
      );
      let queued = false;
      for (const o of rows) {
        const next = await this.retryOrFail(c, o, {
          error: `bot ${o.assigned_bot_id} lost heartbeat for more than ${afterMs} ms`,
          retryable: true,
          actor: 'system',
          reason: 'DELAY_EXPIRED',
        });
        queued ||= next.status === 'QUEUED';
      }
      return { n: rows.length, queued };
    });
    if (n) this.changed();
    if (queued) this.events.emit('orderQueued');
    return n;
  }

  /**
   * IN_PROGRESS for longer than `maxMs` although the bot is alive (heartbeats keep coming, the work
   * does not finish): take the order back and retry it elsewhere. Returns the revoked work so the
   * caller can tell the bot to drop it. maxMs = 0 turns this off.
   */
  async requeueStuckInProgress(maxMs: number): Promise<RevokedWork[]> {
    if (maxMs <= 0) return [];
    const { revoked, queued } = await this.db.tx(async (c) => {
      const { rows } = await c.query<OrderRow>(
        `SELECT * FROM orders
          WHERE status = 'IN_PROGRESS' AND started_at < now() - ($1 || ' milliseconds')::interval
          FOR UPDATE SKIP LOCKED`,
        [String(maxMs)],
      );
      let queued = false;
      for (const o of rows) {
        const next = await this.retryOrFail(c, o, {
          error: `no result from bot ${o.assigned_bot_id} within ${maxMs} ms`,
          retryable: true,
          actor: 'system',
          reason: 'PROCESSING_TIMEOUT',
        });
        queued ||= next.status === 'QUEUED';
      }
      const revoked = rows.map((o) => ({ botId: o.assigned_bot_id!, orderId: Number(o.id), attempt: o.attempt_count }));
      return { revoked, queued };
    });
    if (revoked.length) this.changed();
    if (queued) this.events.emit('orderQueued');
    return revoked;
  }

  /**
   * Called when an agent (re)connects and tells us what it is working on.
   * Returns the order ids the agent must abandon because they were taken away from it.
   */
  async reconcileOnConnect(botId: string, reported: ReportedWork | null): Promise<{ abandon: number[] }> {
    const abandon: number[] = [];
    let changed = false;
    let queued = false;
    await this.db.tx(async (c) => {
      const { rows } = await c.query<OrderRow>(
        `SELECT * FROM orders WHERE assigned_bot_id = $1 AND status = ANY($2::text[]) FOR UPDATE`,
        [botId, ACTIVE_STATUSES],
      );
      const held = rows[0];
      const sameWork =
        held && reported && Number(held.id) === reported.orderId && held.attempt_count === reported.attempt;

      if (held && sameWork && held.status === 'DELAYED') {
        await this.repo.transition(c, {
          orderId: held.id,
          from: ['DELAYED'],
          to: 'IN_PROGRESS',
          set: { delayed_at: null },
          guard: { botId, attempt: held.attempt_count },
          actor: `bot:${botId}`,
          reason: 'BOT_RECONNECTED',
        });
        changed = true;
      } else if (held && !sameWork) {
        // The agent restarted and lost this work - do not wait for the heartbeat timeout.
        const next = await this.retryOrFail(c, held, {
          error: 'agent reconnected without this order (lost work)',
          retryable: true,
          actor: 'system',
          reason: 'AGENT_LOST_WORK',
        });
        changed = true;
        queued = next.status === 'QUEUED';
      }
      if (reported && !sameWork) abandon.push(reported.orderId);
    });
    if (changed) this.changed();
    if (queued) this.events.emit('orderQueued');
    return { abandon };
  }

  /** Late success for an attempt the system ended. Caller holds the transaction; locks the order row. */
  private async completeLate(c: PoolClient, botId: string, work: ReportedWork, result: unknown): Promise<OrderRow | null> {
    const current = await this.repo.findById(c, work.orderId, true);
    if (!current || !['QUEUED', 'FAILED'].includes(current.status)) return null;
    // attempt_count only grows on a claim, so equality means nobody has re-claimed the order.
    if (current.attempt_count !== work.attempt) return null;
    const ended = await this.attemptEnd(c, work);
    if (!ended || ended.botId !== botId || ended.actor !== 'system' || !SYSTEM_ENDED_ATTEMPT.includes(ended.reason)) {
      return null;
    }
    return this.repo.transition(c, {
      orderId: work.orderId,
      from: [current.status],
      to: 'COMPLETED',
      set: {
        assigned_bot_id: botId,
        completed_at: Sql.NOW,
        next_attempt_at: null,
        delayed_at: null,
        last_error: null,
        result: result ?? null,
      },
      guard: { attempt: work.attempt },
      actor: `bot:${botId}`,
      reason: 'BOT_REPORTED_DONE_LATE',
    });
  }

  /** The timeline event that took the order away from `work.attempt` (to QUEUED or FAILED), if any. */
  private async attemptEnd(q: Queryable, work: ReportedWork) {
    const { rows } = await q.query<{ payload: { botId: string; actor: string; reason: string } }>(
      `SELECT payload FROM order_events
        WHERE order_id = $1 AND event_type = 'STATUS_CHANGED'
          AND payload->>'from' = ANY($2::text[]) AND payload->>'to' IN ('QUEUED', 'FAILED')
          AND (payload->>'attempt')::int = $3
        ORDER BY id LIMIT 1`,
      [work.orderId, ACTIVE_STATUSES, work.attempt],
    );
    return rows[0]?.payload ?? null;
  }

  private async explainRejectedReport(
    q: Queryable,
    botId: string,
    work: ReportedWork,
    duplicateOf: 'COMPLETED' | null,
  ): Promise<ReportResult> {
    const current = await this.repo.findById(q, work.orderId);
    if (!current) return { ok: false, reason: 'ORDER_NOT_FOUND' };
    const sameAttempt = current.assigned_bot_id === botId && current.attempt_count === work.attempt;
    if (duplicateOf && current.status === duplicateOf && sameAttempt) {
      return { ok: true, duplicate: true, order: toOrderDto(current) };
    }
    this.logger.warn(
      `rejected stale report from ${botId} for order ${work.orderId} attempt ${work.attempt} (now ${current.status}, attempt ${current.attempt_count})`,
    );
    return { ok: false, reason: 'STALE_ATTEMPT', order: toOrderDto(current) };
  }

  private async setBotResult(q: Queryable, botId: string, result: 'done' | 'failed', summary: string): Promise<void> {
    await q.query(
      `UPDATE oxide_bot_agents
          SET last_result = $2, last_result_summary = $3, last_result_at = now(), updated_at = now()
        WHERE id = $1`,
      [botId, result, summary.slice(0, 500)],
    );
  }

  private changed(): void {
    this.events.emit('changed', 'orders');
    this.events.emit('changed', 'bots');
  }
}

function summarize(order: OrderRow, result: 'done' | 'failed'): string {
  const product = order.product ? ` · ${order.product}` : '';
  return `${order.external_order_id}${product} · ${result === 'done' ? 'สำเร็จ' : 'ล้มเหลว'}`;
}
