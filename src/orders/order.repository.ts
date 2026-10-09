import { Injectable } from '@nestjs/common';
import { Queryable } from '../db/db.service';
import { assertTransition, OrderStatus } from './order-state';

/** A raw SQL expression for a SET clause, e.g. `now()`. Only build these from trusted constants. */
export class Sql {
  constructor(readonly text: string) {}
  static readonly NOW = new Sql('now()');
  static afterMs(ms: number): Sql {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid delay ${ms}`);
    return new Sql(`now() + interval '${Math.round(ms)} milliseconds'`);
  }
}

const MUTABLE_COLUMNS = [
  'assigned_bot_id',
  'last_bot_id',
  'attempt_count',
  'next_attempt_at',
  'started_at',
  'delayed_at',
  'completed_at',
  'last_error',
  'result',
] as const;
type MutableColumn = (typeof MUTABLE_COLUMNS)[number];

export interface OrderRow {
  id: string;
  external_order_id: string;
  status: OrderStatus;
  amount: string;
  currency: string;
  product: string | null;
  customer_ref: string | null;
  assigned_bot_id: string | null;
  /** The bot of the previous attempt, kept after a requeue so the next claim can avoid it. */
  last_bot_id: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  started_at: Date | null;
  delayed_at: Date | null;
  completed_at: Date | null;
  last_error: string | null;
  result: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface TransitionParams {
  orderId: number | string;
  from: readonly OrderStatus[];
  to: OrderStatus;
  set?: Partial<Record<MutableColumn, unknown>>;
  /** Fencing: only succeed if the order is still held by this bot / attempt. */
  guard?: { botId?: string; attempt?: number };
  actor: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

export function toOrderDto(r: OrderRow) {
  return {
    id: Number(r.id),
    externalOrderId: r.external_order_id,
    status: r.status,
    amount: Number(r.amount),
    currency: r.currency,
    product: r.product,
    customerRef: r.customer_ref,
    assignedBotId: r.assigned_bot_id,
    lastBotId: r.last_bot_id,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    startedAt: r.started_at,
    delayedAt: r.delayed_at,
    completedAt: r.completed_at,
    lastError: r.last_error,
    result: r.result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type OrderDto = ReturnType<typeof toOrderDto>;

@Injectable()
export class OrderRepository {
  async findById(q: Queryable, id: number | string, lock = false): Promise<OrderRow | null> {
    const { rows } = await q.query<OrderRow>(`SELECT * FROM orders WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  /**
   * Compare-and-set status change: succeeds only if the order is currently in one of `from`
   * (and matches the guard). Returns null when another actor got there first - the caller
   * decides whether that is a duplicate (fine) or a conflict. Writes a timeline event.
   */
  async transition(q: Queryable, p: TransitionParams): Promise<OrderRow | null> {
    for (const from of p.from) assertTransition(from, p.to);

    const params: unknown[] = [p.orderId, p.from, p.to];
    const sets = ['status = $3', 'updated_at = now()'];
    for (const [column, value] of Object.entries(p.set ?? {})) {
      if (!(MUTABLE_COLUMNS as readonly string[]).includes(column)) throw new Error(`column ${column} is not mutable`);
      if (value instanceof Sql) {
        sets.push(`${column} = ${value.text}`);
      } else {
        params.push(column === 'result' && value !== null ? JSON.stringify(value) : value);
        sets.push(`${column} = $${params.length}`);
      }
    }
    let where = 'id = $1 AND status = ANY($2::text[])';
    if (p.guard?.botId !== undefined) {
      params.push(p.guard.botId);
      where += ` AND assigned_bot_id = $${params.length}`;
    }
    if (p.guard?.attempt !== undefined) {
      params.push(p.guard.attempt);
      where += ` AND attempt_count = $${params.length}`;
    }

    // Lock first so the "from" status we record is the one we actually replaced.
    // The UPDATE's WHERE is still the real guard (compare-and-set).
    const { rows: locked } = await q.query<{ status: OrderStatus; assigned_bot_id: string | null }>(
      `SELECT status, assigned_bot_id FROM orders WHERE id = $1 FOR UPDATE`,
      [p.orderId],
    );
    if (!locked[0]) return null;

    const { rows } = await q.query<OrderRow>(
      `UPDATE orders SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
      params,
    );
    const order = rows[0];
    if (!order) return null;

    await this.addEvent(q, order.id, 'STATUS_CHANGED', {
      from: locked[0].status,
      to: p.to,
      actor: p.actor,
      reason: p.reason ?? null,
      // the bot involved: the new holder, or the one that just lost the order
      botId: order.assigned_bot_id ?? locked[0].assigned_bot_id,
      attempt: order.attempt_count,
      ...p.meta,
    });
    return order;
  }

  async addEvent(q: Queryable, orderId: number | string, type: string, payload: Record<string, unknown>): Promise<void> {
    await q.query(`INSERT INTO order_events (order_id, event_type, payload) VALUES ($1, $2, $3)`, [
      orderId,
      type,
      payload,
    ]);
  }
}
