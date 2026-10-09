import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventsService } from '../common/events.service';
import { AppConfig } from '../config/app-config';
import { DbService } from '../db/db.service';
import { InvalidTransitionError, OrderStatus } from './order-state';
import { OrderDto, OrderRepository, OrderRow, Sql, toOrderDto } from './order.repository';

export interface CreateOrderInput {
  externalOrderId: string;
  amount: number;
  currency?: string;
  product?: string;
  customerRef?: string;
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  botId?: string;
  limit: number;
  offset: number;
}

/** Operator / shop facing order operations. Bot-facing operations live in DispatchService. */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly repo: OrderRepository,
    private readonly events: EventsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * external_order_id is the shop's natural key: creating the same order twice returns
   * the existing one (created=false) instead of a duplicate - even without an Idempotency-Key.
   * The same id with different details is a client bug, not a retry: 409 ORDER_CONFLICT.
   */
  async create(input: CreateOrderInput, actor: string): Promise<{ order: OrderDto; created: boolean }> {
    const fields = {
      amount: input.amount,
      currency: (input.currency ?? 'THB').toUpperCase(),
      product: input.product ?? null,
      customerRef: input.customerRef ?? null,
    };
    const result = await this.db.tx(async (c) => {
      const { rows } = await c.query<OrderRow>(
        `INSERT INTO orders (external_order_id, status, amount, currency, product, customer_ref, max_attempts)
         VALUES ($1, 'PENDING_PAYMENT', $2, $3, $4, $5, $6)
         ON CONFLICT (external_order_id) DO NOTHING
         RETURNING *`,
        [
          input.externalOrderId,
          fields.amount,
          fields.currency,
          fields.product,
          fields.customerRef,
          this.config.orderMaxAttempts,
        ],
      );
      if (rows[0]) {
        await this.repo.addEvent(c, rows[0].id, 'CREATED', { to: 'PENDING_PAYMENT', actor });
        return { order: rows[0], created: true };
      }
      const { rows: existing } = await c.query<OrderRow>(`SELECT * FROM orders WHERE external_order_id = $1`, [
        input.externalOrderId,
      ]);
      const e = existing[0];
      // Compare what the client actually sent: a resend that omits an optional field is not a conflict.
      const sent = {
        amount: true,
        currency: input.currency !== undefined,
        product: input.product !== undefined,
        customerRef: input.customerRef !== undefined,
      };
      const stored = {
        amount: Number(e.amount),
        currency: e.currency,
        product: e.product,
        customerRef: e.customer_ref,
      };
      const mismatched = (Object.keys(fields) as Array<keyof typeof fields>).filter(
        (k) => sent[k] && fields[k] !== stored[k],
      );
      if (mismatched.length) {
        throw new ConflictException({
          error: 'ORDER_CONFLICT',
          message: `externalOrderId ${input.externalOrderId} already exists with different ${mismatched.join(', ')}`,
          orderId: Number(e.id),
          mismatched,
        });
      }
      return { order: e, created: false };
    });
    if (result.created) this.events.emit('changed', 'orders');
    return { order: toOrderDto(result.order), created: result.created };
  }

  /** Payment confirmed -> QUEUED. Repeating it (e.g. a re-sent payment webhook) is a no-op. */
  async confirmPayment(id: number, actor: string): Promise<{ order: OrderDto; changed: boolean }> {
    return this.move(id, actor, {
      from: ['PENDING_PAYMENT'],
      to: 'QUEUED',
      set: { next_attempt_at: Sql.NOW },
      reason: 'PAYMENT_CONFIRMED',
      alreadyDone: ['QUEUED', 'IN_PROGRESS', 'DELAYED', 'COMPLETED'],
      after: () => this.events.emit('orderQueued'),
    });
  }

  /**
   * Only an order no bot has ever taken can be cancelled. A QUEUED order with attempts behind it
   * may already have been delivered (the bot can still report a late success), so cancelling -
   * and refunding - it could lose both the money and the goods.
   */
  async cancel(id: number, actor: string, reason?: string): Promise<{ order: OrderDto; changed: boolean }> {
    return this.move(id, actor, {
      from: ['PENDING_PAYMENT', 'QUEUED'],
      to: 'CANCELLED',
      reason: reason || 'CANCELLED_BY_OPERATOR',
      alreadyDone: ['CANCELLED'],
      guard: {
        attempt: 0,
        error: 'ORDER_ALREADY_ATTEMPTED',
        message: 'A bot has already worked on this order, it may have been delivered - it cannot be cancelled',
      },
    });
  }

  /**
   * Manual retry of a FAILED order. attempt_count keeps growing (it is the fencing token),
   * so we grant a fresh budget by raising max_attempts instead of resetting the counter.
   */
  async retry(id: number, actor: string): Promise<{ order: OrderDto; changed: boolean }> {
    const result = await this.db.tx(async (c) => {
      const current = await this.repo.findById(c, id, true);
      if (!current) throw new NotFoundException({ error: 'ORDER_NOT_FOUND' });
      if (current.status !== 'FAILED') {
        throw new ConflictException({ error: 'INVALID_TRANSITION', from: current.status, to: 'QUEUED' });
      }
      await c.query(`UPDATE orders SET max_attempts = attempt_count + $2 WHERE id = $1`, [
        id,
        this.config.orderMaxAttempts,
      ]);
      return this.repo.transition(c, {
        orderId: id,
        from: ['FAILED'],
        to: 'QUEUED',
        set: { assigned_bot_id: null, last_bot_id: current.assigned_bot_id, next_attempt_at: Sql.NOW, last_error: null },
        actor,
        reason: 'MANUAL_RETRY',
      });
    });
    this.events.emit('changed', 'orders');
    this.events.emit('orderQueued');
    return { order: toOrderDto(result!), changed: true };
  }

  async list(q: ListOrdersQuery): Promise<{ items: OrderDto[]; total: number }> {
    const where = `($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR assigned_bot_id = $2)`;
    const params = [q.status ?? null, q.botId ?? null];
    const [rows, count] = await Promise.all([
      this.db.query<OrderRow>(
        `SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [...params, q.limit, q.offset],
      ),
      this.db.query<{ n: string }>(`SELECT count(*) AS n FROM orders WHERE ${where}`, params),
    ]);
    return { items: rows.map(toOrderDto), total: Number(count[0].n) };
  }

  async get(id: number): Promise<OrderDto> {
    const row = await this.repo.findById(this.db.pool, id);
    if (!row) throw new NotFoundException({ error: 'ORDER_NOT_FOUND' });
    return toOrderDto(row);
  }

  async timeline(id: number) {
    await this.get(id);
    const rows = await this.db.query(
      `SELECT id, event_type, payload, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return rows.map((r) => ({ id: Number(r.id), type: r.event_type, payload: r.payload, createdAt: r.created_at }));
  }

  async countsByStatus(): Promise<Record<OrderStatus, number>> {
    const rows = await this.db.query<{ status: OrderStatus; n: string }>(
      `SELECT status, count(*) AS n FROM orders GROUP BY status`,
    );
    const counts = {
      PENDING_PAYMENT: 0,
      QUEUED: 0,
      IN_PROGRESS: 0,
      DELAYED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLED: 0,
    };
    for (const r of rows) counts[r.status] = Number(r.n);
    return counts;
  }

  private async move(
    id: number,
    actor: string,
    p: {
      from: OrderStatus[];
      to: OrderStatus;
      set?: Record<string, unknown>;
      reason: string;
      alreadyDone: OrderStatus[];
      /** Extra compare-and-set condition, and the 409 to answer when only that condition failed. */
      guard?: { attempt: number; error: string; message: string };
      after?: () => void;
    },
  ): Promise<{ order: OrderDto; changed: boolean }> {
    const result = await this.db.tx(async (c) => {
      const moved = await this.repo.transition(c, {
        orderId: id,
        from: p.from,
        to: p.to,
        set: p.set,
        guard: p.guard && { attempt: p.guard.attempt },
        actor,
        reason: p.reason,
      });
      if (moved) return { order: moved, changed: true };

      const current = await this.repo.findById(c, id);
      if (!current) throw new NotFoundException({ error: 'ORDER_NOT_FOUND' });
      if (p.alreadyDone.includes(current.status)) return { order: current, changed: false };
      if (p.guard && p.from.includes(current.status)) {
        throw new ConflictException({
          error: p.guard.error,
          message: p.guard.message,
          status: current.status,
          attemptCount: current.attempt_count,
        });
      }
      throw new ConflictException({
        error: 'INVALID_TRANSITION',
        message: new InvalidTransitionError(current.status, p.to).message,
        from: current.status,
        to: p.to,
      });
    });
    if (result.changed) {
      this.events.emit('changed', 'orders');
      p.after?.();
    }
    return { order: toOrderDto(result.order), changed: result.changed };
  }
}
