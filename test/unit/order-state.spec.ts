import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  ORDER_STATUSES,
  OrderStatus,
  retryDelayMs,
} from '../../src/orders/order-state';

describe('order state machine', () => {
  const allowed: Array<[OrderStatus, OrderStatus]> = [
    ['PENDING_PAYMENT', 'QUEUED'],
    ['PENDING_PAYMENT', 'CANCELLED'],
    ['QUEUED', 'IN_PROGRESS'],
    ['QUEUED', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETED'],
    ['IN_PROGRESS', 'DELAYED'],
    ['IN_PROGRESS', 'QUEUED'],
    ['IN_PROGRESS', 'FAILED'],
    ['DELAYED', 'IN_PROGRESS'],
    ['DELAYED', 'COMPLETED'],
    ['DELAYED', 'QUEUED'],
    ['DELAYED', 'FAILED'],
    ['FAILED', 'QUEUED'],
    // late success report for an attempt the system had given up on (see DispatchService.complete)
    ['QUEUED', 'COMPLETED'],
    ['FAILED', 'COMPLETED'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every transition not in the table', () => {
    const allowedSet = new Set(allowed.map(([f, t]) => `${f}>${t}`));
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (allowedSet.has(`${from}>${to}`)) continue;
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['PENDING_PAYMENT', 'IN_PROGRESS'], // cannot skip payment
    ['QUEUED', 'DELAYED'], // only an order held by a bot can be delayed
    ['COMPLETED', 'QUEUED'], // terminal
    ['CANCELLED', 'QUEUED'], // terminal
    ['IN_PROGRESS', 'CANCELLED'], // a bot is already spending money on it
  ])('throws InvalidTransitionError for %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('COMPLETED and CANCELLED are terminal', () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransition('COMPLETED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
  });
});

describe('retryDelayMs', () => {
  it('doubles per attempt', () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, 1000))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('is capped', () => {
    expect(retryDelayMs(30, 1000, 60_000)).toBe(60_000);
  });

  it('is zero before the first attempt', () => {
    expect(retryDelayMs(0, 1000)).toBe(0);
  });
});
