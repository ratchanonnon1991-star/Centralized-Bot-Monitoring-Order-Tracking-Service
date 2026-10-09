import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/** Live WebSocket connections of bot agents, keyed by bot id. One connection per bot. */
@Injectable()
export class AgentRegistry {
  private readonly sockets = new Map<string, WebSocket>();

  /** Registers a socket and returns the one it replaced (the caller closes it). */
  register(botId: string, socket: WebSocket): WebSocket | undefined {
    const previous = this.sockets.get(botId);
    this.sockets.set(botId, socket);
    return previous === socket ? undefined : previous;
  }

  /** Removes the socket only if it is still the current one for that bot. */
  unregister(botId: string, socket: WebSocket): boolean {
    if (this.sockets.get(botId) !== socket) return false;
    this.sockets.delete(botId);
    return true;
  }

  isConnected(botId: string): boolean {
    return this.sockets.get(botId)?.readyState === WebSocket.OPEN;
  }

  connectedIds(): string[] {
    return [...this.sockets.keys()].filter((id) => this.isConnected(id));
  }

  send(botId: string, event: string, data: unknown): boolean {
    const socket = this.sockets.get(botId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ event, data }));
    return true;
  }

  broadcast(event: string, data: unknown): void {
    for (const id of this.sockets.keys()) this.send(id, event, data);
  }

  disconnect(botId: string, code: number, reason: string): void {
    this.sockets.get(botId)?.close(code, reason);
  }
}
