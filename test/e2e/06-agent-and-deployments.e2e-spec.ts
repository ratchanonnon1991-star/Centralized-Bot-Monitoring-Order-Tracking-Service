/**
 * The real WebSocket protocol end to end, plus deployment upload / rollout.
 */
import { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { AGENT, AUTH, createTestApp, queuedOrder, resetDb, TestContext } from './helpers';

interface Msg {
  event: string;
  data: any;
}

/** Minimal agent client: collects messages and lets a test await the next one of a kind. */
class TestAgent {
  readonly ws: WebSocket;
  private readonly inbox: Msg[] = [];
  private waiters: Array<{ event: string; resolve: (m: Msg) => void }> = [];
  closed: Promise<number>;

  constructor(url: string, token = AGENT) {
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      const i = this.waiters.findIndex((w) => w.event === msg.event);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
  }

  opened() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }

  send(event: string, data: unknown) {
    this.ws.send(JSON.stringify({ event, data }));
  }

  next(event: string, timeoutMs = 3000): Promise<Msg> {
    const i = this.inbox.findIndex((m) => m.event === event);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      this.waiters.push({ event, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }
}

describe('agent WebSocket protocol', () => {
  let ctx: TestContext;
  let base: string;
  const agents: TestAgent[] = [];
  const agent = (botId: string, token?: string) => {
    const a = new TestAgent(`${base}/ws/agent?botId=${botId}`, token);
    agents.push(a);
    return a;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0);
    base = `ws://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  });
  beforeEach(() => resetDb(ctx.db));
  afterEach(() => agents.splice(0).forEach((a) => a.ws.terminate()));
  afterAll(() => ctx.app.close());

  it('rejects a wrong token with close code 4401', async () => {
    expect(await agent('bot-01', 'nope').closed).toBe(4401);
  });

  it('rejects an unknown bot with 4404', async () => {
    const a = agent('bot-zz');
    await a.opened();
    a.send('hello', {});
    expect(await a.closed).toBe(4404);
  });

  it('hello -> welcome -> claim -> assigned -> complete -> ack; re-sent report is a duplicate', async () => {
    const id = await queuedOrder(ctx);
    const a = agent('bot-01');
    await a.opened();
    a.send('hello', { hostName: 'NB-1', codeVersion: 'v1', currentOrder: null });
    const welcome = await a.next('welcome');
    expect(welcome.data).toMatchObject({ botId: 'bot-01', killSwitch: false, enabled: true, abandon: [] });

    a.send('order.claim', { requestId: 'r1' });
    const assigned = await a.next('order.assigned');
    expect(assigned.data).toMatchObject({ requestId: 'r1', order: { id, attemptCount: 1 } });

    const report = { reportId: 'rep-1', orderId: id, attempt: 1, result: { ref: 'T1' } };
    a.send('order.complete', report);
    expect((await a.next('order.report.ack')).data).toMatchObject({ reportId: 'rep-1', ok: true, duplicate: false });
    a.send('order.complete', report);
    expect((await a.next('order.report.ack')).data).toMatchObject({ reportId: 'rep-1', ok: true, duplicate: true });

    const bot = await ctx.bots.get('bot-01');
    expect(bot).toMatchObject({ hostName: 'NB-1', codeVersion: 'v1', state: 'STANDBY', lastResult: { result: 'done' } });
  });

  it('a second connection for the same bot replaces the first (4409), bot stays online', async () => {
    const a = agent('bot-02');
    await a.opened();
    a.send('hello', {});
    await a.next('welcome');

    const b = agent('bot-02');
    await b.opened();
    b.send('hello', {});
    await b.next('welcome');
    expect(await a.closed).toBe(4409);
    await new Promise((r) => setTimeout(r, 100));
    expect((await ctx.bots.get('bot-02')).status).toBe('online');
  });

  it('commands are delivered live, re-delivered after reconnect, and the kill-switch is broadcast', async () => {
    const cmd = await ctx.commands.create('bot-03', 'status', null, 'test'); // agent offline -> stays queued
    const a = agent('bot-03');
    await a.opened();
    a.send('hello', {});
    await a.next('welcome');
    const delivered = await a.next('command');
    expect(delivered.data).toMatchObject({ commandId: cmd.id, command: 'status' });
    a.send('command.result', { commandId: cmd.id, ok: true, result: { fine: true } });
    await a.next('command.ack');

    await ctx.system.setKillSwitch(true, null, 'test');
    expect((await a.next('system.killSwitch')).data).toEqual({ engaged: true });
  });

  it('socket close marks the bot offline right away', async () => {
    const a = agent('bot-01');
    await a.opened();
    a.send('hello', {});
    await a.next('welcome');
    a.ws.close();
    await a.closed;
    await new Promise((r) => setTimeout(r, 200));
    expect((await ctx.bots.get('bot-01')).status).toBe('offline');
  });

  it('a socket closed while its hello is being handled does not leave the bot online', async () => {
    await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'offline' WHERE id = 'bot-01'`);
    // Hold the hello at its first await, so the socket closes in the middle of it.
    const exists = ctx.bots.exists.bind(ctx.bots);
    let entered!: () => void;
    const inHello = new Promise<void>((r) => (entered = r));
    const spy = jest.spyOn(ctx.bots, 'exists').mockImplementation(async (id) => {
      entered();
      await new Promise((r) => setTimeout(r, 200));
      return exists(id);
    });
    try {
      const a = agent('bot-01');
      await a.opened();
      a.send('hello', {});
      await inHello;
      a.ws.terminate();
      await a.closed;
      await new Promise((r) => setTimeout(r, 400));
      expect((await ctx.bots.get('bot-01')).status).toBe('offline');
    } finally {
      spy.mockRestore();
    }
  });

  it('a command the agent reports as held in its heartbeat does not time out', async () => {
    const a = agent('bot-02');
    await a.opened();
    a.send('hello', {});
    await a.next('welcome');
    const cmd = await ctx.commands.create('bot-02', 'restart', null, 'test');
    expect(cmd.status).toBe('running');
    const age = () =>
      ctx.db.query(`UPDATE oxide_bot_commands SET dispatched_at = now() - interval '1 hour' WHERE id = $1`, [cmd.id]);

    await age();
    a.send('heartbeat', { cpuPercent: 1, memoryPercent: 1, uptimeSeconds: 1, heldCommands: [cmd.id, 'x', -1] });
    await new Promise((r) => setTimeout(r, 200));
    expect(await ctx.commands.expireRunning(1000)).toBe(0);

    await age();
    a.send('heartbeat', { cpuPercent: 1, memoryPercent: 1, uptimeSeconds: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(await ctx.commands.expireRunning(1000)).toBe(1);
  });
});

describe('deployments', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake bot code')]);

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => resetDb(ctx.db));
  afterAll(() => ctx.app.close());

  it('rejects files that are not zip archives', async () => {
    const res = await http().post('/api/deployments').set(AUTH).attach('file', Buffer.from('hello'), 'bot.zip');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PACKAGE');
  });

  it('uploading the same bytes twice returns the same package', async () => {
    const a = await http().post('/api/deployments').set(AUTH).attach('file', zip, 'bot.zip');
    const b = await http().post('/api/deployments').set(AUTH).attach('file', zip, 'bot-again.zip');
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id: a.body.id, created: false });
  });

  it('rollout queues one update per bot; repeating it does not stack commands', async () => {
    const up = await http().post('/api/deployments').set(AUTH).attach('file', zip, 'bot.zip');
    const first = await http().post(`/api/deployments/${up.body.id}/rollout`).set(AUTH).send({});
    const second = await http().post(`/api/deployments/${up.body.id}/rollout`).set(AUTH).send({});

    expect(first.body.targets.map((t: any) => t.outcome)).toEqual(['queued', 'queued', 'queued']);
    expect(second.body.targets.map((t: any) => t.outcome)).toEqual(['already-pending', 'already-pending', 'already-pending']);
    const cmds = await ctx.db.query(`SELECT bot_id FROM oxide_bot_commands WHERE command = 'update'`);
    expect(cmds).toHaveLength(3);
  });

  it('agents can download with their token; the version is recorded when they ack', async () => {
    const up = await http().post('/api/deployments').set(AUTH).attach('file', zip, 'bot.zip');
    const dl = await http().get(up.body.downloadPath).set('Authorization', `Bearer ${AGENT}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-checksum-sha256']).toBe(up.body.sha256);

    const r = await http().post(`/api/deployments/${up.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-01'] });
    await ctx.commands.handleResult('bot-01', r.body.targets[0].command.id, true, { version: up.body.version });
    expect((await ctx.bots.get('bot-01')).codeVersion).toBe(up.body.version);

    const again = await http().post(`/api/deployments/${up.body.id}/rollout`).set(AUTH).send({ botIds: ['bot-01'] });
    expect(again.body.targets[0].outcome).toBe('up-to-date');
  });

  it('admin endpoints refuse the agent token', async () => {
    await http().get('/api/orders').set('Authorization', `Bearer ${AGENT}`).expect(401);
  });
});
