import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { Server, WebSocket } from 'ws';
import { safeEqual } from '../common/auth';
import { ChangeScope, EventsService } from '../common/events.service';
import { AppConfig } from '../config/app-config';

const DEBOUNCE_MS = 250;

/**
 * Dashboard push channel: ws://host/ws/dashboard?token=<ADMIN_TOKEN>.
 * Sends `{event:"changed", data:{scopes:[...]}}`; the page then re-fetches those parts over REST.
 * Changes are batched so a burst of heartbeats becomes one refresh.
 */
/** The dashboard only listens; it never needs to send anything large. */
@WebSocketGateway({ path: '/ws/dashboard', maxPayload: 4 * 1024 })
export class DashboardGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;

  private pending = new Set<ChangeScope>();
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.off = this.events.on('changed', (scope) => this.schedule(scope));
  }

  onModuleDestroy(): void {
    this.off?.();
    if (this.timer) clearTimeout(this.timer);
  }

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (!token || !safeEqual(token, this.config.adminToken)) {
      client.close(4401, 'unauthorized');
      return;
    }
    client.send(JSON.stringify({ event: 'hello', data: { serverTime: new Date() } }));
  }

  private schedule(scope: ChangeScope): void {
    this.pending.add(scope);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      const message = JSON.stringify({ event: 'changed', data: { scopes: [...this.pending] } });
      this.pending.clear();
      this.timer = null;
      this.server?.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) c.send(message);
      });
    }, DEBOUNCE_MS);
  }
}
