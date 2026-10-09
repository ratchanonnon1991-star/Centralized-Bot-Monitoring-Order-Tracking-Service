import { BotAgent } from '../../agent/bot-agent';

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
