/**
 * Case 3 - A bot machine dies or hangs in the middle of an order (heartbeat timeout).
 *   IN_PROGRESS -> DELAYED (bot silent) -> QUEUED for another bot, or FAILED when attempts run out.
 *   If the bot comes back in time, it resumes the same order.
 */
import { createTestApp, orderRow, queuedOrder, resetDb, statusEvents, TestContext } from './helpers';

describe('Case 3: heartbeat timeout', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => resetDb(ctx.db));
  afterAll(() => ctx.app.close());

  const silence = (botId: string) =>
    ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '1 hour' WHERE id = $1`, [botId]);
  const ageDelay = (orderId: number) =>
    ctx.db.query(`UPDATE orders SET delayed_at = now() - interval '1 hour' WHERE id = $1`, [orderId]);

  async function claimedBy(botId: string, maxAttempts?: number) {
    const id = await queuedOrder(ctx, maxAttempts);
    const claim = await ctx.dispatch.claimNext(botId);
    expect(claim.order?.id).toBe(id);
    return { id, attempt: claim.order!.attemptCount };
  }

  it('silent bot -> offline, its order -> DELAYED', async () => {
    const { id } = await claimedBy('bot-01');
    await silence('bot-01');

    const report = await ctx.monitor.tick();

    expect(report?.botsOffline).toEqual(['bot-01']);
    expect(report?.ordersDelayed).toBe(1);
    const row = await orderRow(ctx.db, id);
    expect(row.status).toBe('DELAYED');
    expect(row.assigned_bot_id).toBe('bot-01');
    expect((await statusEvents(ctx.db, id)).at(-1)).toMatchObject({ to: 'DELAYED', reason: 'HEARTBEAT_TIMEOUT' });
  });

  it('DELAYED too long -> back to QUEUED and another bot picks it up', async () => {
    const { id } = await claimedBy('bot-01');
    await silence('bot-01');
    await ctx.monitor.tick();
    await ageDelay(id);

    await ctx.monitor.tick();
    const row = await orderRow(ctx.db, id);
    expect(row.status).toBe('QUEUED');
    expect(row.assigned_bot_id).toBeNull();

    const next = await ctx.dispatch.claimNext('bot-02');
    expect(next.order).toMatchObject({ id, assignedBotId: 'bot-02', attemptCount: 2 });
  });

  it('DELAYED with no attempts left -> FAILED', async () => {
    const { id } = await claimedBy('bot-01', 1);
    await silence('bot-01');
    await ctx.monitor.tick();
    await ageDelay(id);
    await ctx.monitor.tick();

    const row = await orderRow(ctx.db, id);
    expect(row.status).toBe('FAILED');
    expect(row.last_error).toMatch(/lost heartbeat/);
    expect((await statusEvents(ctx.db, id)).at(-1)).toMatchObject({ to: 'FAILED', reason: 'MAX_ATTEMPTS_REACHED' });
  });

  it('bot reconnects still holding the order -> resumes IN_PROGRESS', async () => {
    const { id, attempt } = await claimedBy('bot-01');
    await silence('bot-01');
    await ctx.monitor.tick();

    const { abandon } = await ctx.dispatch.reconcileOnConnect('bot-01', { orderId: id, attempt });
    expect(abandon).toEqual([]);
    expect((await orderRow(ctx.db, id)).status).toBe('IN_PROGRESS');
  });

  it('bot reconnects after a restart without the order -> requeued immediately', async () => {
    const { id } = await claimedBy('bot-01');
    await ctx.dispatch.reconcileOnConnect('bot-01', null);
    const row = await orderRow(ctx.db, id);
    expect(row.status).toBe('QUEUED');
    expect((await statusEvents(ctx.db, id)).at(-1)).toMatchObject({ reason: 'AGENT_LOST_WORK', botId: 'bot-01' });
  });

  it('bot comes back after its order was requeued AND re-claimed -> told to abandon it, its late report is rejected', async () => {
    const { id, attempt } = await claimedBy('bot-01');
    await silence('bot-01');
    await ctx.monitor.tick();
    await ageDelay(id);
    await ctx.monitor.tick(); // requeued
    expect((await ctx.dispatch.claimNext('bot-02')).order).toMatchObject({ id, attemptCount: attempt + 1 });

    const { abandon } = await ctx.dispatch.reconcileOnConnect('bot-01', { orderId: id, attempt });
    expect(abandon).toEqual([id]);
    const late = await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, {});
    expect(late).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
    expect((await orderRow(ctx.db, id)).assigned_bot_id).toBe('bot-02');
  });

  it('a late completion while DELAYED is accepted (the work did finish)', async () => {
    const { id, attempt } = await claimedBy('bot-01');
    await silence('bot-01');
    await ctx.monitor.tick();
    const r = await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, { ref: 'X' });
    expect(r.ok).toBe(true);
    expect((await orderRow(ctx.db, id)).status).toBe('COMPLETED');
  });

  it('an offline bot cannot claim', async () => {
    await queuedOrder(ctx);
    await silence('bot-03');
    await ctx.monitor.tick();
    expect(await ctx.dispatch.claimNext('bot-03')).toEqual({ order: null, reason: 'BOT_OFFLINE' });
  });
});
