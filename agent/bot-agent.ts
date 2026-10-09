/**
 * Local bot agent - stands in for the Oxide bot running on each Node/Notebook.
 *
 *   node dist/agent/bot-agent.js bot-01 [--host NOTEBOOK-01] [--fail-rate 0.2] [--freeze-after 30]
 *
 * Talks to the central server over one WebSocket: hello -> heartbeats, claims orders when idle,
 * "works" on them (sleep), reports done/failed, obeys commands (start/stop/restart/status/update).
 *
 * Reliability rules it follows:
 *  - reconnects forever with exponential backoff + jitter;
 *  - every report (order result, command result) stays in an outbox until the server acks it,
 *    and is re-sent after a reconnect - the server de-duplicates, so re-sending is always safe;
 *  - on hello it tells the server which order it still holds, so the server can resume it
 *    instead of re-queuing it;
 *  - commands are de-duplicated by id (the server re-delivers unacked commands).
 *
 * --freeze-after N: after N seconds the agent goes silent but keeps the socket open (a hung
 * process). Demonstrates the server-side heartbeat timeout; the agent recovers when the
 * server drops the connection.
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

interface AssignedOrder {
  id: number;
  externalOrderId: string;
  attemptCount: number;
  product: string | null;
}

interface Work {
  orderId: number;
  attempt: number;
  externalOrderId: string;
  abort: boolean;
}

interface Message {
  event: string;
  data: Record<string, any>;
}

interface AgentOptions {
  botId: string;
  hostName: string;
  wsUrl: string;
  httpUrl: string;
  token: string;
  heartbeatMs: number;
  failRate: number;
  workMinMs: number;
  workMaxMs: number;
  dataDir: string;
  freezeAfterMs: number | null;
}

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE = new Map([
  [4400, 'invalid bot id'],
  [4401, 'invalid AGENT_TOKEN'],
  [4404, 'bot id is not registered on the server'],
  [4409, 'another agent connected with the same bot id'],
]);

const FAILURE_REASONS = ['game API timeout', 'top-up provider rejected request', 'captcha challenge', 'session expired'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

export class BotAgent {
  private ws: WebSocket | null = null;
  private ready = false;
  private enabled = true;
  private killSwitch = false;
  private frozen = false;
  private current: Work | null = null;
  private readonly outbox = new Map<string, Message>();
  private claimInFlight: string | null = null;
  private readonly answeredCommands = new Map<number, Message>();
  private pendingUpdate: { commandId: number; payload: Record<string, any> } | null = null;
  /** An update is being downloaded/installed; updates never run in parallel. */
  private updating = false;
  /** Command id of the update being installed right now (reported in heartbeats as held). */
  private installingCommandId: number | null = null;
  private restartRequested = false;
  private reconnectAttempt = 0;
  private startedAt = Date.now();
  private codeVersion: string | null = null;
  private stopping = false;

  constructor(private readonly o: AgentOptions) {}

  async start(): Promise<void> {
    this.codeVersion = await readFile(join(this.o.dataDir, 'current-version.txt'), 'utf8')
      .then((s) => s.trim() || null)
      .catch(() => null);
    this.connect();
    setInterval(() => this.heartbeat(), this.o.heartbeatMs);
    setInterval(() => this.maybeClaim(), 2_000);
    if (this.o.freezeAfterMs !== null) {
      setTimeout(() => {
        this.frozen = true;
        this.print('warn', 'FROZEN: no more heartbeats or messages (simulated hang)');
      }, this.o.freezeAfterMs);
    }
  }

  stop(): void {
    this.stopping = true;
    // Between reconnect attempts there is no socket whose close event would end the process.
    if (this.ws) this.ws.close(1000, 'agent shutdown');
    else process.exit(0);
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    if (this.stopping) return;
    const url = `${this.o.wsUrl}?botId=${encodeURIComponent(this.o.botId)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.o.token}` } });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      const held = this.heldWork();
      this.rawSend({
        event: 'hello',
        data: {
          hostName: this.o.hostName,
          codeVersion: this.codeVersion,
          currentOrder: held ? { orderId: held.orderId, attempt: held.attempt } : null,
        },
      });
    });
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', (err) => this.print('warn', `socket error: ${err.message}`));
    ws.on('close', (code, reason) => {
      this.ready = false;
      this.ws = null;
      this.claimInFlight = null;
      if (this.stopping) process.exit(0);
      const fatal = FATAL_CLOSE.get(code);
      if (fatal) {
        this.print('error', `server closed connection: ${fatal} - exiting`);
        process.exit(1);
      }
      if (this.frozen) {
        this.frozen = false;
        this.print('info', 'server dropped us after the heartbeat timeout - recovering from freeze');
      }
      this.print('warn', `disconnected (${code} ${reason.toString() || ''}) - reconnecting`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const base = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    setTimeout(() => this.connect(), base * rand(0.5, 1));
  }

  // ---------------------------------------------------------------- inbound

  private onMessage(raw: string): void {
    if (this.frozen) return;
    let msg: Message;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const d = msg.data ?? {};
    switch (msg.event) {
      case 'welcome':
        this.ready = true;
        this.enabled = d.enabled;
        this.killSwitch = d.killSwitch;
        if (this.current && (d.abandon as number[]).includes(this.current.orderId)) {
          this.current.abort = true;
          this.print('warn', `server says order ${this.current.externalOrderId} is no longer ours - abandoning`);
        }
        this.print('info', `connected (enabled=${this.enabled}, killSwitch=${this.killSwitch})`);
        for (const m of this.outbox.values()) this.rawSend(m);
        this.heartbeat();
        this.maybeClaim();
        break;
      case 'order.available':
        this.maybeClaim();
        break;
      case 'order.assigned':
        if (d.requestId === this.claimInFlight) this.claimInFlight = null;
        void this.work(d.order as AssignedOrder);
        break;
      case 'order.none':
        if (d.requestId === this.claimInFlight) this.claimInFlight = null;
        break;
      case 'order.revoked':
        // The server took the order back (no result within ORDER_MAX_PROCESSING_MS).
        if (this.current && this.current.orderId === d.orderId && this.current.attempt === d.attempt) {
          this.current.abort = true;
          this.print('warn', `server revoked ${this.current.externalOrderId} (took too long) - abandoning`);
        }
        break;
      case 'order.report.ack':
        this.outbox.delete(d.reportId);
        if (!d.ok) this.print('warn', `server rejected report ${d.reportId}: ${d.reason}`);
        break;
      case 'command':
        void this.onCommand(d.commandId, d.command, d.payload ?? {});
        break;
      case 'command.ack':
        this.outbox.delete(`cmd-${d.commandId}`);
        break;
      case 'system.killSwitch':
        this.killSwitch = d.engaged;
        this.print(d.engaged ? 'warn' : 'info', d.engaged ? 'KILL-SWITCH engaged: no new orders' : 'kill-switch released');
        this.maybeClaim();
        break;
      case 'error':
        this.print('error', `server error on ${d.event}: ${d.message}`);
        break;
    }
  }

  // ---------------------------------------------------------------- orders

  private canClaim(): boolean {
    return (
      this.ready &&
      !this.frozen &&
      this.enabled &&
      !this.killSwitch &&
      !this.current &&
      !this.restartRequested &&
      !this.pendingUpdate &&
      !this.updating
    );
  }

  private maybeClaim(): void {
    if (!this.canClaim() || this.claimInFlight) return;
    const requestId = randomUUID();
    this.claimInFlight = requestId;
    this.rawSend({ event: 'order.claim', data: { requestId } });
    setTimeout(() => {
      if (this.claimInFlight === requestId) this.claimInFlight = null;
    }, 5_000);
  }

  private async work(order: AssignedOrder): Promise<void> {
    if (this.current) {
      this.print('error', `got order ${order.externalOrderId} while busy - ignoring (server will time it out)`);
      return;
    }
    const w: Work = { orderId: order.id, attempt: order.attemptCount, externalOrderId: order.externalOrderId, abort: false };
    this.current = w;
    this.log('info', `start ${order.externalOrderId}${order.product ? ` (${order.product})` : ''} attempt #${w.attempt}`);

    const until = Date.now() + rand(this.o.workMinMs, this.o.workMaxMs);
    while (Date.now() < until && !w.abort) await sleep(250);

    this.current = null;
    if (w.abort) {
      this.log('warn', `abandoned ${w.externalOrderId}`);
    } else {
      const reportId = randomUUID();
      const failed = Math.random() < this.o.failRate;
      const msg: Message = failed
        ? {
            event: 'order.fail',
            data: {
              reportId,
              orderId: w.orderId,
              attempt: w.attempt,
              error: FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)],
              retryable: true,
            },
          }
        : {
            event: 'order.complete',
            data: {
              reportId,
              orderId: w.orderId,
              attempt: w.attempt,
              result: { reference: `TX-${randomUUID().slice(0, 8).toUpperCase()}`, deliveredAt: new Date() },
            },
          };
      this.outbox.set(reportId, msg);
      this.rawSend(msg);
      this.log(failed ? 'error' : 'info', `${failed ? 'FAILED' : 'done'} ${w.externalOrderId}${failed ? `: ${msg.data.error}` : ''}`);
    }
    await this.afterWork();
  }

  /** The order we hold: in progress, or finished but the report is not acknowledged yet. */
  private heldWork(): { orderId: number; attempt: number } | null {
    if (this.current) return this.current;
    for (const m of this.outbox.values()) {
      if (m.event === 'order.complete' || m.event === 'order.fail') return m.data as { orderId: number; attempt: number };
    }
    return null;
  }

  private async afterWork(): Promise<void> {
    if (this.pendingUpdate) await this.applyUpdate();
    if (this.restartRequested) return this.restart();
    this.maybeClaim();
  }

  // ---------------------------------------------------------------- commands

  private async onCommand(commandId: number, command: string, payload: Record<string, any>): Promise<void> {
    const previous = this.answeredCommands.get(commandId);
    if (previous) {
      // Re-delivery after a reconnect: answer again, do not execute twice.
      this.rawSend(previous);
      return;
    }
    this.log('info', `command #${commandId}: ${command}`);
    switch (command) {
      case 'start':
        this.enabled = true;
        this.respond(commandId, true, { enabled: true });
        this.maybeClaim();
        return;
      case 'stop':
        this.enabled = false;
        this.respond(commandId, true, { enabled: false, finishing: this.current?.externalOrderId ?? null });
        return;
      case 'status':
        this.respond(commandId, true, this.snapshot());
        return;
      case 'restart':
        this.restartRequested = true;
        this.respond(commandId, true, { restarting: true, afterOrder: this.current?.externalOrderId ?? null });
        if (!this.current) setTimeout(() => this.restart(), 300);
        return;
      case 'update':
        // Only the newest update matters; one still waiting to start is answered as superseded.
        if (this.pendingUpdate) {
          this.respond(this.pendingUpdate.commandId, false, { error: 'SUPERSEDED', supersededBy: commandId });
        }
        this.pendingUpdate = { commandId, payload };
        if (!this.current) await this.afterWork();
        else this.log('info', `update to ${payload.version} deferred until ${this.current.externalOrderId} finishes`);
        return;
      default:
        this.respond(commandId, false, { error: `unknown command ${command}` });
    }
  }

  private respond(commandId: number, ok: boolean, result: unknown): void {
    const msg: Message = { event: 'command.result', data: { commandId, ok, result } };
    this.answeredCommands.set(commandId, msg);
    if (this.answeredCommands.size > 200) this.answeredCommands.delete(this.answeredCommands.keys().next().value!);
    this.outbox.set(`cmd-${commandId}`, msg);
    this.rawSend(msg);
  }

  /** Installs pending updates one after another; a call while one is running just leaves it queued. */
  private async applyUpdate(): Promise<void> {
    if (this.updating) return;
    this.updating = true;
    try {
      while (this.pendingUpdate) {
        const next = this.pendingUpdate;
        this.pendingUpdate = null;
        this.installingCommandId = next.commandId;
        try {
          await this.installUpdate(next.commandId, next.payload);
        } finally {
          this.installingCommandId = null;
        }
      }
    } finally {
      this.updating = false;
    }
  }

  private async installUpdate(commandId: number, payload: Record<string, any>): Promise<void> {
    try {
      const version = String(payload.version);
      const path = String(payload.downloadPath);
      if (!/^[A-Za-z0-9_.-]+$/.test(version) || !path.startsWith('/api/deployments/')) throw new Error('bad update payload');

      const res = await fetch(this.o.httpUrl + path, { headers: { Authorization: `Bearer ${this.o.token}` } });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== payload.sha256) throw new Error('checksum mismatch');

      // A real bot would unpack and restart itself; here we keep the package and switch the version pointer.
      const releases = join(this.o.dataDir, 'releases');
      await mkdir(releases, { recursive: true });
      await writeFile(join(releases, `${version}.zip`), data);
      await writeFile(join(this.o.dataDir, 'current-version.txt'), version);
      this.codeVersion = version;
      this.respond(commandId, true, { version, sha256, installedAt: new Date() });
      this.log('info', `updated to ${version}`);
    } catch (err) {
      this.respond(commandId, false, { error: (err as Error).message });
      this.log('error', `update failed: ${(err as Error).message}`);
    }
  }

  private restart(): void {
    this.restartRequested = false;
    this.log('info', 'restarting');
    this.startedAt = Date.now();
    this.ws?.close(1012, 'agent restart'); // close handler reconnects
  }

  // ---------------------------------------------------------------- telemetry

  private heartbeat(): void {
    if (!this.ready || this.frozen) return;
    const busy = !!this.current;
    this.rawSend({
      event: 'heartbeat',
      data: {
        cpuPercent: Number((busy ? rand(35, 75) : rand(3, 12)).toFixed(1)),
        memoryPercent: Number((busy ? rand(45, 60) : rand(30, 42)).toFixed(1)),
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        codeVersion: this.codeVersion,
        // Taken but not answered yet: an update deferred until the current order ends, or still
        // downloading, can outlast the server's COMMAND_TIMEOUT_MS - this keeps it from timing out.
        heldCommands: [this.pendingUpdate?.commandId, this.installingCommandId].filter((id) => id != null),
      },
    });
  }

  private snapshot() {
    return {
      enabled: this.enabled,
      killSwitch: this.killSwitch,
      codeVersion: this.codeVersion,
      currentOrder: this.current?.externalOrderId ?? null,
      unackedReports: this.outbox.size,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private rawSend(msg: Message): boolean {
    if (this.frozen || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Print locally and ship to the server's bot log (best effort). */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.print(level, message);
    if (this.ready) this.rawSend({ event: 'log', data: { level, message } });
  }

  private print(level: string, message: string): void {
    const line = `${new Date().toISOString().slice(11, 19)} [${this.o.botId}] ${level.toUpperCase().padEnd(5)} ${message}`;
    (level === 'error' ? console.error : console.log)(line);
  }
}

// ------------------------------------------------------------------ CLI

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  // pnpm forwards a literal "--" (`pnpm agent -- bot-01`); it is not an argument.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  // First argument that is neither a --flag nor a flag's value.
  const botId = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))[0];
  const token = process.env.AGENT_TOKEN;
  if (!botId || !token) {
    console.error('usage: node dist/agent/bot-agent.js <botId> [--host NAME] [--fail-rate 0.15] [--freeze-after SEC]');
    console.error('AGENT_TOKEN must be set (see .env.example)');
    process.exit(1);
  }
  const freeze = flag(args, 'freeze-after');
  const agent = new BotAgent({
    botId,
    hostName: flag(args, 'host') ?? `${hostname()}-${botId}`,
    wsUrl: process.env.BACKEND_WS_URL ?? 'ws://localhost:3001/ws/agent',
    httpUrl: process.env.BACKEND_HTTP_URL ?? 'http://localhost:3001',
    token,
    heartbeatMs: Number(process.env.AGENT_HEARTBEAT_INTERVAL_MS ?? 3000),
    failRate: Number(flag(args, 'fail-rate') ?? process.env.AGENT_FAIL_RATE ?? 0.15),
    workMinMs: Number(process.env.AGENT_WORK_MIN_MS ?? 3000),
    workMaxMs: Number(process.env.AGENT_WORK_MAX_MS ?? 7000),
    dataDir: resolve(process.env.AGENT_DATA_DIR ?? 'agent-data', botId),
    freezeAfterMs: freeze ? Number(freeze) * 1000 : null,
  });
  process.on('SIGINT', () => agent.stop());
  process.on('SIGTERM', () => agent.stop());
  void agent.start();
}

if (require.main === module) main();
