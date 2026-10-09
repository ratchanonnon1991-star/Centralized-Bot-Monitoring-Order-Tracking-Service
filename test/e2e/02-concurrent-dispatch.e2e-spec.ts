/**
 * Case 2 - Concurrency: many bots ask for work at the same moment.
 * An order must go to exactly one bot, and a bot must never hold two orders.
 */
import { addBots, createTestApp, orderRow, queuedOrder, resetDb, statusEvents, TestContext } from './helpers';

describe('Case 2: concurrent order dispatch', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => resetDb(ctx.db));
  afterAll(() => ctx.app.close());

  it('10 bots x 5 parallel claims for 6 orders: every order assigned once, every bot at most once', async () => {
    const extra = Array.from({ length: 7 }, (_, i) => `bot-x${i}`);
    await addBots(ctx.db, extra);
    const botIds = ['bot-01', 'bot-02', 'bot-03', ...extra];
    const orderIds = [];
    for (let i = 0; i < 6; i++) orderIds.push(await queuedOrder(ctx));

    const claims = botIds.flatMap((bot) => Array.from({ length: 5 }, () => ctx.dispatch.claimNext(bot)));
    const results = await Promise.all(claims);

    const won = results.filter((r) => r.order).map((r) => r.order!);
    expect(won).toHaveLength(6);
    expect(new Set(won.map((o) => o.id)).size).toBe(6); // no order twice
    expect(new Set(won.map((o) => o.assignedBotId)).size).toBe(6); // no bot twice

    for (const id of orderIds) {
      const row = await orderRow(ctx.db, id);
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.attempt_count).toBe(1);
      expect((await statusEvents(ctx.db, id)).filter((e) => e.to === 'IN_PROGRESS')).toHaveLength(1);
    }
  });

  it('a bot that already holds an order gets BOT_BUSY', async () => {
    await queuedOrder(ctx);
    await queuedOrder(ctx);
    const first = await ctx.dispatch.claimNext('bot-01');
    const second = await ctx.dispatch.claimNext('bot-01');
    expect(first.order).not.toBeNull();
    expect(second).toEqual({ order: null, reason: 'BOT_BUSY' });
  });

  it('the database refuses a second active order per bot even if code had a bug', async () => {
    const a = await queuedOrder(ctx);
    const b = await queuedOrder(ctx);
    await ctx.dispatch.claimNext('bot-01');
    const other = (await orderRow(ctx.db, a)).status === 'IN_PROGRESS' ? b : a;
    await expect(
      ctx.db.query(`UPDATE orders SET status = 'IN_PROGRESS', assigned_bot_id = 'bot-01' WHERE id = $1`, [other]),
    ).rejects.toThrow(/uq_orders_one_active_per_bot/);
  });

  it('completion racing the timeout requeue: the order always ends COMPLETED, never queued again', async () => {
    for (let round = 0; round < 10; round++) {
      await resetDb(ctx.db);
      const id = await queuedOrder(ctx);
      const claim = await ctx.dispatch.claimNext('bot-01');
      const attempt = claim.order!.attemptCount;
      await ctx.db.query(
        `UPDATE orders SET status = 'DELAYED', delayed_at = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );

      const [report] = await Promise.all([
        ctx.dispatch.complete('bot-01', { orderId: id, attempt }, { ok: true }),
        ctx.dispatch.requeueExpiredDelayed(1),
      ]);

      // Whichever runs first, the work was done and nobody re-claimed it: it must end COMPLETED,
      // never back in the queue (that would deliver the top-up twice).
      const row = await orderRow(ctx.db, id);
      expect(report.ok).toBe(true);
      expect(row.status).toBe('COMPLETED');
    }
  });

  it('orders are handed out FIFO', async () => {
    const first = await queuedOrder(ctx);
    await queuedOrder(ctx);
    const claim = await ctx.dispatch.claimNext('bot-02');
    expect(claim.order!.id).toBe(first);
  });
});
