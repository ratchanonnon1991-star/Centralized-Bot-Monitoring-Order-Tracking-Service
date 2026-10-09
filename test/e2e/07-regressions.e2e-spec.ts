/**
 * Regression tests for bugs found by abuse testing: wrong input, rapid double-clicks,
 * several operators clicking at once, and misbehaving agents. One block per finding.
 */
import { rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { EventsService } from '../../src/common/events.service';
import { AGENT_MAX_PAYLOAD_BYTES } from '../../src/realtime/agent.gateway';
import { AGENT, AUTH, createTestApp, orderRow, queuedOrder, resetDb, statusEvents, TestContext } from './helpers';

const zip = (fill: number) => Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(fill)]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('regressions', () => {
  let ctx: TestContext;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    ctx = await createTestApp({ orderMaxProcessingMs: 60_000 });
    await ctx.app.listen(0);
    base = `ws://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  });
  beforeEach(() => resetDb(ctx.db));
  afterEach(() => sockets.splice(0).forEach((s) => s.terminate()));
  afterAll(() => ctx.app.close());

  const http = () => request(ctx.app.getHttpServer());
  const n = async (sql: string, params: unknown[] = []) => (await ctx.db.query(sql, params))[0].n as number;

  /** Raw agent connection that records every message it gets. */
  function agent(botId: string) {
    const ws = new WebSocket(`${base}/ws/agent?botId=${botId}`, { headers: { Authorization: `Bearer ${AGENT}` } });
    sockets.push(ws);
    const msgs: Array<{ event: string; data: any }> = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    return {
      ws,
      msgs,
      opened: new Promise<void>((r) => ws.once('open', () => r())),
      closed: new Promise<number>((r) => ws.on('close', (code) => r(code))),
      send: (event: string, data: unknown) => ws.send(JSON.stringify({ event, data })),
      until: async (event: string, timeoutMs = 3000) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const m = msgs.find((x) => x.event === event);
          if (m) return m;
          await wait(20);
        }
        throw new Error(`timeout waiting for ${event}`);
      },
    };
  }

  /** bot-01 claims an order, goes silent, the order is DELAYED and then given up (requeued or failed). */
  async function givenUpByHeartbeat(maxAttempts?: number) {
    const id = await queuedOrder(ctx, maxAttempts);
    const claim = await ctx.dispatch.claimNext('bot-01');
    await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '1 hour' WHERE id = 'bot-01'`);
    await ctx.monitor.tick(); // -> DELAYED
    await ctx.db.query(`UPDATE orders SET delayed_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await ctx.monitor.tick(); // -> QUEUED / FAILED
    return { id, attempt: claim.order!.attemptCount };
  }

  describe('1. late success report after the system gave up (would deliver the top-up twice)', () => {
    it('requeued but not re-claimed -> the late completion is accepted', async () => {
      const { id, attempt } = await givenUpByHeartbeat();
      expect((await orderRow(ctx.db, id)).status).toBe('QUEUED');

      const r = await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, { ref: 'LATE' });
      expect(r).toMatchObject({ ok: true, duplicate: false });
      const row = await orderRow(ctx.db, id);
      expect(row).toMatchObject({ status: 'COMPLETED', assigned_bot_id: 'bot-01', next_attempt_at: null });
      expect((await statusEvents(ctx.db, id)).at(-1)).toMatchObject({ from: 'QUEUED', reason: 'BOT_REPORTED_DONE_LATE' });
      // and nobody can claim it any more
      expect(await ctx.dispatch.claimNext('bot-02')).toEqual({ order: null, reason: 'NO_ORDER' });
    });

    it('FAILED because attempts ran out while the bot was offline -> the late completion is accepted', async () => {
      const { id, attempt } = await givenUpByHeartbeat(1);
      expect((await orderRow(ctx.db, id)).status).toBe('FAILED');
      expect(await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, {})).toMatchObject({ ok: true });
      expect((await orderRow(ctx.db, id)).status).toBe('COMPLETED');
    });

    it('re-sending that late completion is a duplicate, not a second change', async () => {
      const { id, attempt } = await givenUpByHeartbeat();
      await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, {});
      expect(await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, {})).toMatchObject({ ok: true, duplicate: true });
      expect((await statusEvents(ctx.db, id)).filter((e) => e.to === 'COMPLETED')).toHaveLength(1);
    });

    it('another bot cannot complete an attempt that was not its own', async () => {
      const { id, attempt } = await givenUpByHeartbeat();
      expect(await ctx.dispatch.complete('bot-02', { orderId: id, attempt }, {})).toMatchObject({
        ok: false,
        reason: 'STALE_ATTEMPT',
      });
      expect((await orderRow(ctx.db, id)).status).toBe('QUEUED');
    });

    it('the bot itself reported failure for that attempt -> a later "done" for it is rejected', async () => {
      const id = await queuedOrder(ctx);
      const c = await ctx.dispatch.claimNext('bot-01');
      const work = { orderId: id, attempt: c.order!.attemptCount };
      await ctx.dispatch.fail('bot-01', work, 'captcha', true);
      expect(await ctx.dispatch.complete('bot-01', work, {})).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
      expect((await orderRow(ctx.db, id)).status).toBe('QUEUED');
    });
  });

  describe('2. the same package uploaded several times at once', () => {
    it('never fails with 500 and stores one deployment and one file', async () => {
      const res = await Promise.all(
        Array.from({ length: 8 }, () => http().post('/api/deployments').set(AUTH).attach('file', zip(9), 'x.zip')),
      );
      expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
      expect(await n(`SELECT count(*)::int n FROM deployments`)).toBe(1);

      const dl = await http().get(`/api/deployments/${res[0].body.id}/download`).set(AUTH).buffer(true);
      expect(dl.status).toBe(200);
      expect(dl.headers['x-checksum-sha256']).toBe(res[0].body.sha256);
    });
  });

  describe('3. kill-switch clicked by several operators at once', () => {
    it('10 x "engage" at once -> one audit entry', async () => {
      await Promise.all(
        Array.from({ length: 10 }, () => http().put('/api/system/kill-switch').set(AUTH).send({ engaged: true })),
      );
      expect(await n(`SELECT count(*)::int n FROM audit_logs WHERE action = 'KILL_SWITCH_ENGAGED'`)).toBe(1);
    });

    it('rapid on/off toggling -> audit entries alternate and the last one matches the final state', async () => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          http().put('/api/system/kill-switch').set(AUTH).send({ engaged: i % 2 === 0 }),
        ),
      );
      const audit = (await ctx.db.query(`SELECT action FROM audit_logs WHERE target_type = 'system' ORDER BY id`)).map(
        (a) => a.action,
      );
      for (let i = 1; i < audit.length; i++) expect(audit[i]).not.toBe(audit[i - 1]);
      const final = await ctx.system.getKillSwitch();
      if (audit.length) expect(audit.at(-1)).toBe(final.engaged ? 'KILL_SWITCH_ENGAGED' : 'KILL_SWITCH_RELEASED');
      else expect(final.engaged).toBe(false);
    });
  });

  describe('4. "update code" clicked many times at once', () => {
    it('queues one update command per bot, the others report already-pending', async () => {
      const dep = await http().post('/api/deployments').set(AUTH).attach('file', zip(4), 'a.zip');
      const res = await Promise.all(
        Array.from({ length: 10 }, () =>
          http().post(`/api/deployments/${dep.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-02'] }),
        ),
      );
      const outcomes = res.map((r) => r.body.targets[0].outcome);
      expect(outcomes.filter((o) => o === 'queued')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'already-pending')).toHaveLength(9);
      expect(await n(`SELECT count(*)::int n FROM oxide_bot_commands WHERE command = 'update'`)).toBe(1);
    });
  });

  describe('5. order stuck IN_PROGRESS while its bot keeps sending heartbeats', () => {
    it('is taken back after ORDER_MAX_PROCESSING_MS, retried elsewhere, and the bot is told to drop it', async () => {
      const a = agent('bot-01');
      await a.opened;
      a.send('hello', {});
      await a.until('welcome');
      const id = await queuedOrder(ctx);
      a.send('order.claim', { requestId: 'r1' });
      const assigned = await a.until('order.assigned');

      await ctx.db.query(`UPDATE orders SET started_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
      const report = await ctx.monitor.tick();
      expect(report?.ordersTimedOut).toBe(1);

      const row = await orderRow(ctx.db, id);
      expect(row).toMatchObject({ status: 'QUEUED', assigned_bot_id: null });
      expect((await statusEvents(ctx.db, id)).at(-1)).toMatchObject({ reason: 'PROCESSING_TIMEOUT', botId: 'bot-01' });
      const revoked = await a.until('order.revoked');
      expect(revoked.data).toEqual({ orderId: id, attempt: assigned.data.order.attemptCount });
    });

    it('an order younger than the limit is left alone', async () => {
      const id = await queuedOrder(ctx);
      await ctx.dispatch.claimNext('bot-01');
      expect((await ctx.monitor.tick())?.ordersTimedOut).toBe(0);
      expect((await orderRow(ctx.db, id)).status).toBe('IN_PROGRESS');
    });
  });

  describe('6. same externalOrderId sent with different details', () => {
    const create = (body: object, key: string) => http().post('/api/orders').set(AUTH).set('Idempotency-Key', key).send(body);

    it('different amount -> 409 ORDER_CONFLICT, the stored order is unchanged', async () => {
      expect((await create({ externalOrderId: 'DUP-1', amount: 100 }, 'reg-key-0001')).status).toBe(201);
      const b = await create({ externalOrderId: 'DUP-1', amount: 999 }, 'reg-key-0002');
      expect(b.status).toBe(409);
      expect(b.body).toMatchObject({ error: 'ORDER_CONFLICT', mismatched: ['amount'] });
      expect(Number((await ctx.db.query(`SELECT amount FROM orders WHERE external_order_id = 'DUP-1'`))[0].amount)).toBe(100);
    });

    it('identical details (currency in another case) -> still 200 created=false', async () => {
      await create({ externalOrderId: 'DUP-2', amount: 5, currency: 'THB', product: 'UC 60' }, 'reg-key-0003');
      const b = await create({ externalOrderId: 'DUP-2', amount: 5, currency: 'thb', product: 'UC 60' }, 'reg-key-0004');
      expect(b.status).toBe(200);
      expect(b.body.created).toBe(false);
    });
  });

  describe('7. malformed ids and NUL characters give 400, never 500', () => {
    it.each([
      '/api/orders/99999999999999999999',
      '/api/orders/9223372036854775808',
      '/api/orders/0',
      '/api/orders/-1',
      '/api/orders/1e3',
      '/api/orders/007',
      '/api/deployments/99999999999999999999/download',
      '/api/bots/%00',
      '/api/bots/bad%20id',
      `/api/bots/${'x'.repeat(65)}/logs`,
      '/api/orders?botId=%00',
      '/api/audit-logs?targetId=%00',
    ])('GET %s -> 400', async (path) => {
      const r = await http().get(path).set(AUTH);
      expect(r.status).toBe(400);
    });

    it('NUL inside text fields of a body -> 400', async () => {
      const r = await http()
        .post('/api/orders')
        .set(AUTH)
        .set('Idempotency-Key', 'reg-key-0010')
        .send({ externalOrderId: 'NUL-1', amount: 1, product: 'a\u0000b' });
      expect(r.status).toBe(400);
      const ks = await http().put('/api/system/kill-switch').set(AUTH).send({ engaged: true, reason: 'x\u0000' });
      expect(ks.status).toBe(400);
    });

    it('NUL inside an agent report / log is stripped and the report is applied', async () => {
      const a = agent('bot-01');
      await a.opened;
      a.send('hello', { hostName: 'NB\u0000-01' });
      await a.until('welcome');
      const id = await queuedOrder(ctx);
      a.send('order.claim', { requestId: 'r1' });
      const { data } = await a.until('order.assigned');
      a.send('log', { level: 'info', message: 'he\u0000llo' });
      a.send('order.complete', { reportId: 'nul', orderId: id, attempt: data.order.attemptCount, result: { ref: 'A\u0000B' } });
      expect((await a.until('order.report.ack')).data).toMatchObject({ ok: true });
      expect((await orderRow(ctx.db, id)).result).toEqual({ ref: 'AB' });
      expect(await n(`SELECT count(*)::int n FROM bot_logs WHERE message = 'hello'`)).toBe(1);
    });
  });

  describe('8. the same failure report sent twice (ack lost)', () => {
    it('is acknowledged as a duplicate, like a duplicate completion', async () => {
      const id = await queuedOrder(ctx);
      const c = await ctx.dispatch.claimNext('bot-01');
      const work = { orderId: id, attempt: c.order!.attemptCount };
      expect(await ctx.dispatch.fail('bot-01', work, 'captcha', true)).toMatchObject({ ok: true, duplicate: false });
      expect(await ctx.dispatch.fail('bot-01', work, 'captcha', true)).toMatchObject({ ok: true, duplicate: true });
      expect((await statusEvents(ctx.db, id)).filter((e) => e.reason === 'BOT_REPORTED_FAILURE')).toHaveLength(1);
    });

    it('also for the final failure that made the order FAILED', async () => {
      const id = await queuedOrder(ctx, 1);
      const c = await ctx.dispatch.claimNext('bot-01');
      const work = { orderId: id, attempt: c.order!.attemptCount };
      await ctx.dispatch.fail('bot-01', work, 'provider down', true);
      expect(await ctx.dispatch.fail('bot-01', work, 'provider down', true)).toMatchObject({ ok: true, duplicate: true });
    });
  });

  describe('9. Idempotency-Key left "processing" by a crashed server', () => {
    const create = () =>
      http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'reg-crash-01').send({ externalOrderId: 'CR-1', amount: 5 });

    it('is taken over after it goes stale instead of blocking the key for 24 hours', async () => {
      await ctx.db.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at)
         VALUES ('POST /api/orders', 'reg-crash-01', repeat('0', 64), 'processing', now() - interval '5 minutes')`,
      );
      const r = await create();
      expect(r.status).toBe(201);
    });

    it('a fresh "processing" key still answers 409 (the first request may still be running)', async () => {
      await ctx.db.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash, status)
         VALUES ('POST /api/orders', 'reg-crash-01', repeat('0', 64), 'processing')`,
      );
      expect((await create()).status).toBe(409);
    });
  });

  describe('10. the same body with keys in another order', () => {
    it('replays instead of answering 422', async () => {
      const send = (raw: string) =>
        http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'reg-key-0020').set('content-type', 'application/json').send(raw);
      expect((await send('{"externalOrderId":"K-1","amount":5}')).status).toBe(201);
      const b = await send('{"amount":5,"externalOrderId":"K-1"}');
      expect(b.status).toBe(201);
      expect(b.headers['idempotent-replayed']).toBe('true');
    });
  });

  describe('11. amount and currency validation', () => {
    it.each([
      [{ amount: 0 }, 'amount'],
      [{ amount: 5, currency: '1$x' }, 'currency'],
      [{ amount: 5, currency: 'TH' }, 'currency'],
    ])('%j -> 400', async (extra, field) => {
      const r = await http()
        .post('/api/orders')
        .set(AUTH)
        .set('Idempotency-Key', `reg-val-${field}-${Object.keys(extra).length}-${JSON.stringify(extra).length}`)
        .send({ externalOrderId: 'V-1', ...extra });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body.message)).toContain(field);
    });

    it('0.01 THB is fine', async () => {
      const r = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'reg-val-ok-1').send({ externalOrderId: 'V-2', amount: 0.01 });
      expect(r.status).toBe(201);
    });
  });

  describe('12. orderQueued is announced only after the change is committed', () => {
    it('a listener reading the order from another connection already sees it QUEUED', async () => {
      const seen: Promise<string>[] = [];
      const off = ctx.app.get(EventsService).on('orderQueued', () => {
          seen.push(ctx.db.query(`SELECT status FROM orders ORDER BY id DESC LIMIT 1`).then((r) => r[0].status));
        });
      try {
        const id = await queuedOrder(ctx); // payment confirmed
        const c = await ctx.dispatch.claimNext('bot-01');
        await ctx.dispatch.fail('bot-01', { orderId: id, attempt: c.order!.attemptCount }, 'x', true); // retry
        expect(seen.length).toBe(2);
        expect(await Promise.all(seen)).toEqual(['QUEUED', 'QUEUED']);
      } finally {
        off();
      }
    });
  });

  describe('13. commands of a bot that does not exist', () => {
    it('GET /api/bots/:id/commands -> 404 like /logs', async () => {
      expect((await http().get('/api/bots/nope/commands').set(AUTH)).status).toBe(404);
      expect((await http().get('/api/bots/nope/logs').set(AUTH)).status).toBe(404);
    });
  });

  describe('14. agent protocol abuse', () => {
    it('hello sent 10 times on one socket is handled once', async () => {
      const a = agent('bot-01');
      await a.opened;
      for (let i = 0; i < 10; i++) a.send('hello', {});
      await a.until('welcome');
      await wait(300);
      expect(a.msgs.filter((m) => m.event === 'welcome')).toHaveLength(1);
      expect(await n(`SELECT count(*)::int n FROM bot_logs WHERE bot_id = 'bot-01' AND message LIKE 'agent connected%'`)).toBe(1);
    });

    it('a message over the size limit closes the socket with 1009; the server stays up', async () => {
      const a = agent('bot-02');
      await a.opened;
      a.send('hello', {});
      await a.until('welcome');
      a.send('log', { message: 'z'.repeat(AGENT_MAX_PAYLOAD_BYTES + 1) });
      expect(await a.closed).toBe(1009);
      expect((await http().get('/api/health')).status).toBe(200);
    });
  });

  describe('15. dashboard kill-switch hint', () => {
    it('no longer claims the system is off while it is on', async () => {
      const js = await http().get('/app.js');
      expect(js.status).toBe(200);
      expect(js.text).not.toContain("'ปิดทั้งระบบแล้ว ทุกเครื่องจะไม่รับออเดอร์ใหม่ (งานที่กำลังทำจะทำต่อจนจบ)'");
      expect(js.text).toContain('ทุกเครื่องรับออเดอร์ตามปกติ');
    });
  });

  // ---------------------------------------------------------------- second round (live testing)

  describe('16. a retry is not handed straight back to the bot that just failed or hung', () => {
    it('another bot gets it; the same bot is told NO_ORDER', async () => {
      const id = await queuedOrder(ctx);
      const c = await ctx.dispatch.claimNext('bot-01');
      await ctx.dispatch.fail('bot-01', { orderId: id, attempt: c.order!.attemptCount }, 'captcha', true);

      expect(await ctx.dispatch.claimNext('bot-01')).toEqual({ order: null, reason: 'NO_ORDER' });
      const next = await ctx.dispatch.claimNext('bot-02');
      expect(next.order).toMatchObject({ id, assignedBotId: 'bot-02', lastBotId: 'bot-01' });
    });

    it('the same bot only skips that order, not the rest of the queue', async () => {
      const failed = await queuedOrder(ctx);
      const c = await ctx.dispatch.claimNext('bot-01');
      await ctx.dispatch.fail('bot-01', { orderId: failed, attempt: c.order!.attemptCount }, 'x', true);
      const other = await queuedOrder(ctx);
      expect((await ctx.dispatch.claimNext('bot-01')).order?.id).toBe(other);
    });

    it('when no other bot takes it, the same bot may retry after RETRY_SAME_BOT_AFTER_MS', async () => {
      const id = await queuedOrder(ctx);
      const c = await ctx.dispatch.claimNext('bot-01');
      await ctx.dispatch.fail('bot-01', { orderId: id, attempt: c.order!.attemptCount }, 'x', true);
      await ctx.db.query(`UPDATE orders SET next_attempt_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [
        id,
        String(ctx.config.retrySameBotAfterMs + 1000),
      ]);
      expect((await ctx.dispatch.claimNext('bot-01')).order?.id).toBe(id);
    });

    it('also after a processing timeout', async () => {
      const id = await queuedOrder(ctx);
      await ctx.dispatch.claimNext('bot-01');
      await ctx.db.query(`UPDATE orders SET started_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
      await ctx.monitor.tick();
      expect(await ctx.dispatch.claimNext('bot-01')).toEqual({ order: null, reason: 'NO_ORDER' });
      expect((await ctx.dispatch.claimNext('bot-03')).order?.id).toBe(id);
    });
  });

  describe('17. package file lost from disk (e.g. host wiped its disk on redeploy)', () => {
    it('download says 410 PACKAGE_FILE_MISSING; uploading the same zip again restores it', async () => {
      const up = await http().post('/api/deployments').set(AUTH).attach('file', zip(11), 'p.zip');
      const [row] = await ctx.db.query(`SELECT storage_path FROM deployments WHERE id = $1`, [up.body.id]);
      rmSync(row.storage_path);

      const gone = await http().get(`/api/deployments/${up.body.id}/download`).set(AUTH);
      expect(gone.status).toBe(410);
      expect(gone.body.error).toBe('PACKAGE_FILE_MISSING');

      const again = await http().post('/api/deployments').set(AUTH).attach('file', zip(11), 'p.zip');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: up.body.id, created: false });
      const dl = await http().get(`/api/deployments/${up.body.id}/download`).set(AUTH).buffer(true);
      expect(dl.status).toBe(200);
      expect(await n(`SELECT count(*)::int n FROM audit_logs WHERE action = 'DEPLOYMENT_FILE_RESTORED'`)).toBe(1);
    });
  });

  describe('18. a newer update supersedes an older one still pending', () => {
    it('leaves exactly one open update per bot, the newest', async () => {
      const a = await http().post('/api/deployments').set(AUTH).attach('file', zip(21), 'a.zip');
      const b = await http().post('/api/deployments').set(AUTH).attach('file', zip(22), 'b.zip');
      await http().post(`/api/deployments/${a.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-01'] });
      await http().post(`/api/deployments/${b.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-01'] });

      const open = await ctx.db.query(
        `SELECT payload->>'version' AS v FROM oxide_bot_commands WHERE bot_id = 'bot-01' AND command = 'update' AND status IN ('queued','running')`,
      );
      expect(open.map((r) => r.v)).toEqual([b.body.version]);
      const [old] = await ctx.db.query(
        `SELECT status, result FROM oxide_bot_commands WHERE payload->>'version' = $1`,
        [a.body.version],
      );
      expect(old).toMatchObject({ status: 'failed', result: { error: 'SUPERSEDED' } });
    });

    it('rolling back to the older package is just another newest update', async () => {
      const a = await http().post('/api/deployments').set(AUTH).attach('file', zip(23), 'a.zip');
      const b = await http().post('/api/deployments').set(AUTH).attach('file', zip(24), 'b.zip');
      for (const d of [a, b, a]) await http().post(`/api/deployments/${d.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-02'] });
      const open = await ctx.db.query(
        `SELECT payload->>'version' AS v FROM oxide_bot_commands WHERE bot_id = 'bot-02' AND command = 'update' AND status IN ('queued','running')`,
      );
      expect(open.map((r) => r.v)).toEqual([a.body.version]);
    });

    it('back to the installed version while another update is pending -> not "up-to-date", it cancels that update', async () => {
      const a = await http().post('/api/deployments').set(AUTH).attach('file', zip(25), 'a.zip');
      const b = await http().post('/api/deployments').set(AUTH).attach('file', zip(26), 'b.zip');
      await ctx.db.query(`UPDATE oxide_bot_agents SET code_version = $1 WHERE id = 'bot-01'`, [a.body.version]);
      await http().post(`/api/deployments/${b.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-01'] }); // B pending

      const back = await http().post(`/api/deployments/${a.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-01'] });
      expect(back.body.targets[0].outcome).toBe('queued');
      const open = await ctx.db.query(
        `SELECT payload->>'version' AS v FROM oxide_bot_commands WHERE bot_id = 'bot-01' AND command = 'update' AND status IN ('queued','running')`,
      );
      expect(open.map((r) => r.v)).toEqual([a.body.version]);
    });

    it('the heartbeat reports the version really installed, even if an update ack was lost', async () => {
      const s = agent('bot-03');
      await s.opened;
      s.send('hello', {});
      await s.until('welcome');
      s.send('heartbeat', { cpuPercent: 1, memoryPercent: 1, uptimeSeconds: 1, codeVersion: 'oxide-installed-1' });
      await wait(300);
      expect((await ctx.db.query(`SELECT code_version FROM oxide_bot_agents WHERE id = 'bot-03'`))[0].code_version).toBe(
        'oxide-installed-1',
      );
    });
  });

  describe('19. huge offset', () => {
    it('GET /api/orders?offset=99999999999999999999 -> 400, not 500', async () => {
      expect((await http().get('/api/orders?offset=99999999999999999999').set(AUTH)).status).toBe(400);
    });
  });

  describe('20. Thai package file name', () => {
    it('is stored as sent, not as latin1 mojibake', async () => {
      const r = await http().post('/api/deployments').set(AUTH).attach('file', zip(31), 'โค้ด ใหม่.zip');
      expect(r.status).toBe(201);
      expect(r.body.fileName).toBe('โค้ด ใหม่.zip');
    });
  });

  // ---------------------------------------------------------------- third round

  describe('21. resending an order without its optional fields', () => {
    it('is not a conflict (http/api.http example): 200 created=false', async () => {
      const send = (body: object, key: string) => http().post('/api/orders').set(AUTH).set('Idempotency-Key', key).send(body);
      await send({ externalOrderId: 'OPT-1', amount: 349, currency: 'THB', product: 'UC 600', customerRef: 'p#1' }, 'reg-opt-0001');
      const again = await send({ externalOrderId: 'OPT-1', amount: 349 }, 'reg-opt-0002');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ created: false, product: 'UC 600' });
      // a field that IS sent still has to match
      const wrong = await send({ externalOrderId: 'OPT-1', amount: 349, product: 'UC 60' }, 'reg-opt-0003');
      expect(wrong.status).toBe(409);
      expect(wrong.body.mismatched).toEqual(['product']);
    });
  });

  describe('22. cancelling an order a bot has already worked on', () => {
    it('requeued after a lost bot -> 409 ORDER_ALREADY_ATTEMPTED, and the late success still completes it', async () => {
      const { id, attempt } = await givenUpByHeartbeat();
      const r = await http().post(`/api/orders/${id}/cancel`).set(AUTH).send({});
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'ORDER_ALREADY_ATTEMPTED', status: 'QUEUED', attemptCount: attempt });
      expect(await ctx.dispatch.complete('bot-01', { orderId: id, attempt }, {})).toMatchObject({ ok: true });
      expect((await orderRow(ctx.db, id)).status).toBe('COMPLETED');
    });

    it('requeued after a bot-reported failure -> also 409', async () => {
      const id = await queuedOrder(ctx);
      const c = await ctx.dispatch.claimNext('bot-02');
      await ctx.dispatch.fail('bot-02', { orderId: id, attempt: c.order!.attemptCount }, 'x', true);
      expect((await http().post(`/api/orders/${id}/cancel`).set(AUTH).send({})).status).toBe(409);
    });

    it('a QUEUED order no bot has touched can still be cancelled; cancelling twice is a no-op', async () => {
      const id = await queuedOrder(ctx);
      const a = await http().post(`/api/orders/${id}/cancel`).set(AUTH).send({});
      const b = await http().post(`/api/orders/${id}/cancel`).set(AUTH).send({});
      expect([a.status, a.body.changed, b.status, b.body.changed]).toEqual([200, true, 200, false]);
    });

    it('the dashboard hides the cancel button for attempted orders', async () => {
      expect((await http().get('/app.js')).text).toContain("o.attemptCount === 0) actions.push(");
    });
  });

  describe('23. restoring a lost package file from several uploads at once', () => {
    it('restores it once (one audit entry) and serves it', async () => {
      const up = await http().post('/api/deployments').set(AUTH).attach('file', zip(41), 'r.zip');
      const [row] = await ctx.db.query(`SELECT storage_path FROM deployments WHERE id = $1`, [up.body.id]);
      rmSync(row.storage_path);
      const res = await Promise.all(
        Array.from({ length: 6 }, () => http().post('/api/deployments').set(AUTH).attach('file', zip(41), 'r.zip')),
      );
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect(await n(`SELECT count(*)::int n FROM audit_logs WHERE action = 'DEPLOYMENT_FILE_RESTORED'`)).toBe(1);
      expect((await http().get(`/api/deployments/${up.body.id}/download`).set(AUTH)).status).toBe(200);
    });
  });

  describe('24. startup checks the database', () => {
    it('refuses to start when a migration has not been applied, naming it', async () => {
      const [last] = await ctx.db.query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`);
      await ctx.db.query(`DELETE FROM schema_migrations WHERE name = $1`, [last.name]);
      try {
        await expect(createTestApp()).rejects.toThrow(new RegExp(`missing migrations ${last.name}.*pnpm db:migrate`));
      } finally {
        await ctx.db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [last.name]);
      }
    });

    it('refuses to start when PostgreSQL is unreachable, saying where it looked', async () => {
      await expect(createTestApp({ databaseUrl: 'postgresql://x:y@127.0.0.1:1/none' })).rejects.toThrow(
        /Cannot reach PostgreSQL at 127\.0\.0\.1:1\/none/,
      );
    });
  });
});
