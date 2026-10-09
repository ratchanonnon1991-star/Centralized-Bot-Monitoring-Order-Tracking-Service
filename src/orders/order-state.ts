/**
 * Order state machine.
 *
 *   PENDING_PAYMENT -> QUEUED -> IN_PROGRESS -> COMPLETED
 *                        ^          |   ^
 *                        |          v   |
 *                        +------ DELAYED  (bot heartbeat lost)
 *
 *   IN_PROGRESS / DELAYED -> QUEUED  retry (attempts left)  | -> FAILED (no attempts left)
 *   PENDING_PAYMENT / QUEUED -> CANCELLED
 *   FAILED -> QUEUED                  manual retry by an operator
 *   QUEUED / FAILED -> COMPLETED      late success report: the bot that held the attempt finished it
 *                                     after the system gave up on it, and nobody has re-claimed it yet
 */
export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'QUEUED',
  'IN_PROGRESS',
  'DELAYED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['QUEUED', 'CANCELLED'],
  QUEUED: ['IN_PROGRESS', 'CANCELLED', 'COMPLETED'],
  IN_PROGRESS: ['COMPLETED', 'DELAYED', 'QUEUED', 'FAILED'],
  DELAYED: ['IN_PROGRESS', 'COMPLETED', 'QUEUED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['QUEUED', 'COMPLETED'],
  CANCELLED: [],
};

/** Statuses in which an order is held by a bot. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['IN_PROGRESS', 'DELAYED'];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Invalid order transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Exponential backoff for retry number `attempt` (1-based), capped, with no jitter so tests stay deterministic. */
export function retryDelayMs(attempt: number, baseMs: number, capMs = 60_000): number {
  if (attempt < 1) return 0;
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}
