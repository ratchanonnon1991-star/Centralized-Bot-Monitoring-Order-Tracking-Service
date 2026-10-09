/**
 * Case 5 - Kill-switch pressed while bots are taking orders.
 * After the switch commits, no bot may start a new order; work already running may finish.
 */
import request from 'supertest';
import { AUTH, createTestApp, orderRow, queuedOrder, resetDb, TestContext } from './helpers';

describe('Case 5: global kill-switch', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => resetDb(ctx.db));
  afterAll(() => ctx.app.close());

  it('engaged -> every claim is refused, summary shows nobody accepting work', async () => {
    await queuedOrder(ctx);
    const put = await http().put('/api/system/kill-switch').set(AUTH).send({ engaged: true, reason: 'test' });
    expect(put.status).toBe(200);

    const results = await Promise.all(['bot-01', 'bot-02', 'bot-03'].map((b) => ctx.dispatch.claimNext(b)));
    expect(results.every((r) => r.order === null && r.reason === 'KILL_SWITCH')).toBe(true);

    const overview = await http().get('/api/overview').set(AUTH);
    expect(overview.body.bots).toMatchObject({ online: 3, active: 0, standby: 0 });
  });

  it('work already in progress may still complete while engaged', async () => {
    const id = await queuedOrder(ctx);
    const c = await ctx.dispatch.claimNext('bot-01');
    await ctx.system.setKillSwitch(true, null, 'test');
    const r = await ctx.dispatch.complete('bot-01', { orderId: id, attempt: c.order!.attemptCount }, {});
    expect(r.ok).toBe(true);
    expect((await orderRow(ctx.db, id)).status).toBe('COMPLETED');
  });

  it('flipping the switch waits for an in-flight claim, and no claim starts after it', async () => {
    // Simulate a claim transaction that has already read the switch (holds the share lock).
    const client = await ctx.db.pool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT value FROM system_settings WHERE key = 'kill_switch' FOR SHARE`);

    let flipped = false;
    const flip = ctx.system.setKillSwitch(true, 'race', 'test').then(() => (flipped = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(flipped).toBe(false); // blocked behind the in-flight claim

    await client.query('COMMIT');
    client.release();
    await flip;
    expect(flipped).toBe(true);

    await queuedOrder(ctx);
    expect(await ctx.dispatch.claimNext('bot-01')).toEqual({ order: null, reason: 'KILL_SWITCH' });
  });

  it('claims racing the flip either finished before it or were refused', async () => {
    for (let i = 0; i < 5; i++) await queuedOrder(ctx);
    const claims = ['bot-01', 'bot-02', 'bot-03'].map((b) => ctx.dispatch.claimNext(b));
    const flip = ctx.system.setKillSwitch(true, null, 'test');
    const results = await Promise.all(claims);
    await flip;

    for (const r of results) {
      if (!r.order) expect(['KILL_SWITCH', 'NO_ORDER']).toContain(r.reason);
    }
    const after = await Promise.all(['bot-01', 'bot-02', 'bot-03'].map((b) => ctx.dispatch.claimNext(b)));
    expect(after.every((r) => r.order === null)).toBe(true);
  });

  it('released -> claims work again; setting the same state twice writes one audit entry', async () => {
    await ctx.system.setKillSwitch(true, null, 'test');
    await ctx.system.setKillSwitch(true, null, 'test');
    await ctx.system.setKillSwitch(false, null, 'test');
    await queuedOrder(ctx);
    expect((await ctx.dispatch.claimNext('bot-01')).order).not.toBeNull();

    const audit = await ctx.db.query(`SELECT action FROM audit_logs WHERE target_type = 'system' ORDER BY id`);
    expect(audit.map((a) => a.action)).toEqual(['KILL_SWITCH_ENGAGED', 'KILL_SWITCH_RELEASED']);
  });

  it('per-bot stop takes effect immediately, even if the agent has not received it', async () => {
    await queuedOrder(ctx);
    await http().post('/api/bots/bot-02/commands').set(AUTH).send({ command: 'stop' }).expect(201);
    expect(await ctx.dispatch.claimNext('bot-02')).toEqual({ order: null, reason: 'BOT_DISABLED' });
    expect((await ctx.dispatch.claimNext('bot-01')).order).not.toBeNull();
  });
});
