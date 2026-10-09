/**
 * Case 4 - Retry: bot reports failure, reports arrive twice, reports arrive late,
 * commands are re-delivered after a reconnect.
 */
import { createTestApp, orderRow, queuedOrder, resetDb, statusEvents, TestContext } from './helpers';

describe('Case 4: retry, backoff and duplicate reports', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ retryBaseDelayMs: 20_000 });
  });
  beforeEach(() => resetDb(ctx.db));
  afterAll(() => ctx.app.close());

  const skipBackoff = (id: number) => ctx.db.query(`UPDATE orders SET next_attempt_at = now() WHERE id = $1`, [id]);

  it('retryable failure -> QUEUED with exponential backoff, not claimable until it elapses', async () => {
    const id = await queuedOrder(ctx);
    const c1 = await ctx.dispatch.claimNext('bot-01');
    await ctx.dispatch.fail('bot-01', { orderId: id, attempt: c1.order!.attemptCount }, 'captcha', true);

    const row = await orderRow(ctx.db, id);
    expect(row.status).toBe('QUEUED');
    expect(row.last_error).toBe('captcha');
    const delay = new Date(row.next_attempt_at).getTime() - Date.now();
    expect(delay).toBeGreaterThan(15_000); // base 20s for attempt 1
    expect(await ctx.dispatch.claimNext('bot-02')).toEqual({ order: null, reason: 'NO_ORDER' });

    await skipBackoff(id);
    const c2 = await ctx.dispatch.claimNext('bot-02');
    expect(c2.order).toMatchObject({ id, attemptCount: 2 });
    await ctx.dispatch.fail('bot-02', { orderId: id, attempt: 2 }, 'captcha', true);
    const row2 = await orderRow(ctx.db, id);
    expect(new Date(row2.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(35_000); // doubled: 40s
  });

  it('after max attempts -> FAILED; manual retry gives a new budget without resetting the fencing token', async () => {
    const id = await queuedOrder(ctx, 2);
    for (const bot of ['bot-01', 'bot-02']) {
      await skipBackoff(id);
      const c = await ctx.dispatch.claimNext(bot);
      await ctx.dispatch.fail(bot, { orderId: id, attempt: c.order!.attemptCount }, 'provider down', true);
    }
    let row = await orderRow(ctx.db, id);
    expect(row.status).toBe('FAILED');
    expect(row.attempt_count).toBe(2);

    await ctx.orders.retry(id, 'operator');
    row = await orderRow(ctx.db, id);
    expect(row.status).toBe('QUEUED');
    expect(row.attempt_count).toBe(2);
    expect(row.max_attempts).toBe(2 + ctx.config.orderMaxAttempts);

    const c3 = await ctx.dispatch.claimNext('bot-03');
    expect(c3.order!.attemptCount).toBe(3);
    // A report for the old attempt 1 can never match again.
    expect(await ctx.dispatch.complete('bot-01', { orderId: id, attempt: 1 }, {})).toMatchObject({
      ok: false,
      reason: 'STALE_ATTEMPT',
    });
  });

  it('non-retryable failure -> FAILED immediately', async () => {
    const id = await queuedOrder(ctx);
    const c = await ctx.dispatch.claimNext('bot-01');
    await ctx.dispatch.fail('bot-01', { orderId: id, attempt: c.order!.attemptCount }, 'invalid game account', false);
    expect((await orderRow(ctx.db, id)).status).toBe('FAILED');
  });

  it('the same completion sent 5 times (agent re-sends after reconnect) is applied once', async () => {
    const id = await queuedOrder(ctx);
    const c = await ctx.dispatch.claimNext('bot-01');
    const work = { orderId: id, attempt: c.order!.attemptCount };

    const results = await Promise.all(Array.from({ length: 5 }, () => ctx.dispatch.complete('bot-01', work, { ref: 'A' })));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((await statusEvents(ctx.db, id)).filter((e) => e.to === 'COMPLETED')).toHaveLength(1);
  });

  it('a report from a bot that does not hold the order is rejected', async () => {
    const id = await queuedOrder(ctx);
    const c = await ctx.dispatch.claimNext('bot-01');
    const r = await ctx.dispatch.complete('bot-02', { orderId: id, attempt: c.order!.attemptCount }, {});
    expect(r).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
    expect((await orderRow(ctx.db, id)).status).toBe('IN_PROGRESS');
  });

  it('command results are applied once even when acked twice', async () => {
    const cmd = await ctx.commands.create('bot-01', 'status', null, 'test');
    expect(cmd.status).toBe('queued'); // no agent connected, no simulator in tests
    expect(await ctx.commands.handleResult('bot-01', cmd.id, true, { a: 1 })).toBe(true);
    expect(await ctx.commands.handleResult('bot-01', cmd.id, false, { a: 2 })).toBe(false);
    const [row] = await ctx.db.query(`SELECT status, result FROM oxide_bot_commands WHERE id = $1`, [cmd.id]);
    expect(row).toEqual({ status: 'success', result: { a: 1 } });
  });

  it('a command sent but never answered times out', async () => {
    const cmd = await ctx.commands.create('bot-01', 'restart', null, 'test');
    await ctx.db.query(
      `UPDATE oxide_bot_commands SET status = 'running', dispatched_at = now() - interval '1 hour' WHERE id = $1`,
      [cmd.id],
    );
    expect(await ctx.commands.expireRunning(1000)).toBe(1);
    const [row] = await ctx.db.query(`SELECT status, result FROM oxide_bot_commands WHERE id = $1`, [cmd.id]);
    expect(row).toEqual({ status: 'failed', result: { error: 'TIMEOUT' } });
  });
});
