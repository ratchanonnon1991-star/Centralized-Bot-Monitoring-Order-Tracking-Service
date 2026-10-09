import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

export type SimulatorResult = { ok: true; body: unknown } | { ok: false; error: string };

/** Commands the candidate-pack simulator understands (POST /bots/:id/commands). */
export const SIMULATOR_COMMANDS = ['start', 'stop', 'restart', 'status'] as const;

const MAX_TRIES = 3;
const TIMEOUT_MS = 3_000;

/**
 * HTTP client for the Bot Simulator from the candidate pack. Used as the fallback transport
 * when a bot has no live agent connection. Retries network errors and 5xx with backoff;
 * 4xx are final (retrying a bad request cannot help).
 */
@Injectable()
export class SimulatorClient {
  private readonly logger = new Logger(SimulatorClient.name);

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.botSimulatorUrl !== null;
  }

  async sendCommand(botId: string, command: string): Promise<SimulatorResult> {
    if (!this.config.botSimulatorUrl) return { ok: false, error: 'simulator not configured' };
    const url = `${this.config.botSimulatorUrl}/bots/${encodeURIComponent(botId)}/commands`;
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = await res.json().catch(() => null);
        if (res.ok) return { ok: true, body };
        lastError = `simulator responded ${res.status}: ${JSON.stringify(body)}`;
        if (res.status < 500) return { ok: false, error: lastError };
      } catch (err) {
        lastError = `simulator unreachable: ${(err as Error).message}`;
      }
      if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
    this.logger.warn(`${command} -> ${botId} failed after ${MAX_TRIES} tries: ${lastError}`);
    return { ok: false, error: lastError };
  }
}
