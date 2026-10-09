import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { BotsService, LogLevel } from '../bots/bots.service';
import { CommandsService } from '../bots/commands.service';
import { AgentRegistry } from '../common/agent-registry.service';
import { bearerToken, safeEqual } from '../common/auth';
import { EventsService } from '../common/events.service';
import { BOT_ID_PATTERN, stripNul } from '../common/validation';
import { AppConfig } from '../config/app-config';
import { DispatchService, ReportedWork } from '../orders/dispatch.service';
import { SystemService } from '../system/system.service';

interface AgentSocket extends WebSocket {
  botId?: string;
  /** Set when a hello starts being handled; a second hello on the same socket is ignored. */
  greeted?: boolean;
  /** Set after a successful hello; other messages are ignored before that. */
  ready?: boolean;
}

type Payload = Record<string, unknown> | undefined;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
/** Largest agent message accepted; bigger frames close the socket with 1009 (message too big). */
export const AGENT_MAX_PAYLOAD_BYTES = 256 * 1024;

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const str = (v: unknown, max: number) => {
  const s = typeof v === 'string' ? stripNul(v).slice(0, max) : '';
  return s.length > 0 ? s : null;
};

function work(data: Payload): ReportedWork | null {
  const orderId = posInt(data?.orderId);
  const attempt = posInt(data?.attempt);
  return orderId && attempt ? { orderId, attempt } : null;
}

/**
 * Bot agent channel: ws://host/ws/agent?botId=bot-01 with `Authorization: Bearer <AGENT_TOKEN>`.
 * Messages are JSON `{ "event": "...", "data": {...} }` in both directions.
 * The full protocol is documented in README.md.
 */
@WebSocketGateway({ path: '/ws/agent', maxPayload: AGENT_MAX_PAYLOAD_BYTES })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly registry: AgentRegistry,
    private readonly bots: BotsService,
    private readonly dispatch: DispatchService,
    private readonly commands: CommandsService,
    private readonly system: SystemService,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe.push(
      this.events.on('killSwitch', (engaged) => this.registry.broadcast('system.killSwitch', { engaged })),
      this.events.on('orderQueued', () => this.registry.broadcast('order.available', {})),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe.forEach((off) => off());
  }

  handleConnection(client: AgentSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = bearerToken(req.headers.authorization) ?? url.searchParams.get('token');
    if (!token || !safeEqual(token, this.config.agentToken)) {
      client.close(4401, 'unauthorized');
      return;
    }
    const botId = url.searchParams.get('botId');
    if (!botId || !BOT_ID_PATTERN.test(botId)) {
      client.close(4400, 'invalid botId');
      return;
    }
    client.botId = botId;
  }

  handleDisconnect(client: AgentSocket): void {
    const botId = client.botId;
    if (!botId || !client.ready) return;
    // A socket replaced by a newer connection of the same bot must not mark the bot offline.
    if (!this.registry.unregister(botId, client)) return;
    this.bots.recordDisconnect(botId, 'socket closed').catch((err) => this.fail('disconnect', err));
  }

  @SubscribeMessage('hello')
  async onHello(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    const botId = client.botId;
    // One hello per connection: a repeated hello would re-run reconciliation and re-deliver commands.
    if (!botId || client.greeted) return;
    client.greeted = true;
    try {
      if (!(await this.bots.exists(botId))) {
        client.close(4404, 'unknown bot');
        return;
      }
      // Closed while we were checking: handleDisconnect skipped it (not ready yet), so registering
      // it now would leave the bot "online" with a dead socket until the heartbeat timeout.
      if (client.readyState !== WebSocket.OPEN) return;
      this.registry.register(botId, client)?.close(4409, 'replaced by a newer connection');
      client.ready = true;

      await this.bots.recordConnect(botId, {
        hostName: str(data?.hostName, 120),
        codeVersion: str(data?.codeVersion, 120),
      });
      const current = work(data?.currentOrder as Payload);
      const { abandon } = await this.dispatch.reconcileOnConnect(botId, current);
      const [killSwitch, enabled] = await Promise.all([this.system.getKillSwitch(), this.bots.isEnabled(botId)]);

      this.send(client, 'welcome', {
        botId,
        killSwitch: killSwitch.engaged,
        enabled,
        abandon,
        heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      });
      await this.commands.deliverPending(botId);
    } catch (err) {
      this.fail('hello', err, client);
    }
  }

  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    if (!client.ready || !client.botId) return;
    try {
      await this.bots.recordHeartbeat(client.botId, {
        cpuPercent: num(data?.cpuPercent),
        memoryPercent: num(data?.memoryPercent),
        uptimeSeconds: num(data?.uptimeSeconds),
        codeVersion: str(data?.codeVersion, 120),
      });
      const held = Array.isArray(data?.heldCommands) ? data.heldCommands.slice(0, 20).map(posInt) : [];
      await this.commands.keepAlive(
        client.botId,
        held.filter((id): id is number => id !== null),
      );
    } catch (err) {
      this.fail('heartbeat', err, client);
    }
  }

  @SubscribeMessage('order.claim')
  async onClaim(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    if (!client.ready || !client.botId) return;
    const requestId = str(data?.requestId, 64);
    try {
      const result = await this.dispatch.claimNext(client.botId);
      if (result.order) this.send(client, 'order.assigned', { requestId, order: result.order });
      else this.send(client, 'order.none', { requestId, reason: result.reason });
    } catch (err) {
      this.fail('order.claim', err, client);
      this.send(client, 'order.none', { requestId, reason: 'ERROR' });
    }
  }

  @SubscribeMessage('order.complete')
  async onComplete(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    if (!client.ready || !client.botId) return;
    const reportId = str(data?.reportId, 64);
    const w = work(data);
    if (!w) return this.send(client, 'order.report.ack', { reportId, ok: false, reason: 'INVALID_REPORT' });
    try {
      const r = await this.dispatch.complete(client.botId, w, stripNul(data?.result ?? null));
      this.send(client, 'order.report.ack', { reportId, ok: r.ok, duplicate: r.duplicate, reason: r.reason });
    } catch (err) {
      // No ack: the agent keeps the report in its outbox and re-sends it later.
      this.fail('order.complete', err, client);
    }
  }

  @SubscribeMessage('order.fail')
  async onFail(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    if (!client.ready || !client.botId) return;
    const reportId = str(data?.reportId, 64);
    const w = work(data);
    if (!w) return this.send(client, 'order.report.ack', { reportId, ok: false, reason: 'INVALID_REPORT' });
    try {
      const r = await this.dispatch.fail(
        client.botId,
        w,
        str(data?.error, 500) ?? 'unknown error',
        data?.retryable !== false,
      );
      this.send(client, 'order.report.ack', { reportId, ok: r.ok, duplicate: r.duplicate, reason: r.reason });
    } catch (err) {
      this.fail('order.fail', err, client);
    }
  }

  @SubscribeMessage('command.result')
  async onCommandResult(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    if (!client.ready || !client.botId) return;
    const commandId = posInt(data?.commandId);
    if (!commandId) return;
    try {
      await this.commands.handleResult(client.botId, commandId, data?.ok === true, stripNul(data?.result ?? null));
      this.send(client, 'command.ack', { commandId });
    } catch (err) {
      this.fail('command.result', err, client);
    }
  }

  @SubscribeMessage('log')
  async onLog(@ConnectedSocket() client: AgentSocket, @MessageBody() data: Payload) {
    if (!client.ready || !client.botId) return;
    const level = LOG_LEVELS.includes(data?.level as LogLevel) ? (data!.level as LogLevel) : 'info';
    const message = str(data?.message, 2000);
    if (!message) return;
    try {
      await this.bots.addLog(client.botId, level, message);
    } catch (err) {
      this.fail('log', err, client);
    }
  }

  private send(client: WebSocket, event: string, data: unknown): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ event, data }));
  }

  private fail(what: string, err: unknown, client?: AgentSocket): void {
    this.logger.error(`${what} from ${client?.botId ?? '?'} failed: ${(err as Error).message}`);
    if (client) this.send(client, 'error', { event: what, message: 'internal error' });
  }
}
