import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type ChangeScope = 'bots' | 'orders' | 'system' | 'deployments' | 'commands';

interface AppEvents {
  /** Something the dashboard shows has changed. */
  changed: [scope: ChangeScope];
  /** An order became claimable - idle agents should ask for work. */
  orderQueued: [];
  killSwitch: [enabled: boolean];
}

/**
 * In-process event bus. Services emit only after their transaction commits,
 * so listeners never observe uncommitted state.
 */
@Injectable()
export class EventsService {
  private readonly emitter = new EventEmitter();

  emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]): void {
    this.emitter.emit(event, ...args);
  }

  on<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...a: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...a: unknown[]) => void);
  }
}
