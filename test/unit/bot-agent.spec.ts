import { BotAgent, REPORT_RESEND_MS } from '../../agent/bot-agent';

describe('BotAgent.stop', () => {
  const options = {
    botId: 'bot-x',
    hostName: 'h',
    wsUrl: 'ws://127.0.0.1:1/ws/agent',
    httpUrl: 'http://127.0.0.1:1',
    token: 't',
    heartbeatMs: 3000,
    failRate: 0,
    workMinMs: 1,
    workMaxMs: 2,
    dataDir: '.',
    freezeAfterMs: null,
  };

  afterEach(() => jest.restoreAllMocks());

  it('exits right away between reconnect attempts and does not reconnect afterwards', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const agent = new BotAgent(options);
    // no socket: the state while a reconnect is scheduled
    agent.stop();
    expect(exit).toHaveBeenCalledWith(0);

    // the reconnect timer that was already scheduled fires later
    (agent as unknown as { connect(): void }).connect();
    expect((agent as unknown as { ws: unknown }).ws).toBeNull();
  });
});

describe('BotAgent outbox', () => {
  const options = {
    botId: 'bot-x',
    hostName: 'h',
    wsUrl: 'ws://127.0.0.1:1/ws/agent',
    httpUrl: 'http://127.0.0.1:1',
    token: 't',
    heartbeatMs: 3000,
    failRate: 0,
    workMinMs: 1,
    workMaxMs: 2,
    dataDir: '.',
    freezeAfterMs: null,
  };

  afterEach(() => jest.restoreAllMocks());

  /** An agent on a healthy connection, recording what it sends. */
  function connectedAgent() {
    const sent: Array<{ event: string; data: any }> = [];
    const agent = new BotAgent(options);
    const a = agent as unknown as {
      ws: unknown;
      ready: boolean;
      post(id: string, msg: unknown): void;
      heartbeat(): void;
      onMessage(raw: string): void;
    };
    a.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
    a.ready = true;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    return { a, sent, reports: () => sent.filter((m) => m.event === 'order.complete') };
  }

  it('re-sends an unacked report on a heartbeat after REPORT_RESEND_MS, without a reconnect', () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { a, reports } = connectedAgent();
    a.post('r1', { event: 'order.complete', data: { reportId: 'r1', orderId: 1, attempt: 1 } });
    expect(reports()).toHaveLength(1);

    now += REPORT_RESEND_MS - 1;
    a.heartbeat();
    expect(reports()).toHaveLength(1); // not yet: the ack may just be slow

    now += 1;
    a.heartbeat();
    expect(reports()).toHaveLength(2);

    a.onMessage(JSON.stringify({ event: 'order.report.ack', data: { reportId: 'r1', ok: true } }));
    now += REPORT_RESEND_MS;
    a.heartbeat();
    expect(reports()).toHaveLength(2); // acked: never sent again
  });
});
