/**
 * Case 1 - Idempotency: the same order request arrives more than once
 * (client retry after a timeout, double click, payment webhook re-sent).
 */
import request from 'supertest';
import { AUTH, createTestApp, resetDb, statusEvents, TestContext } from './helpers';

describe('Case 1: idempotent order creation and payment', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
    // Listen once up front; otherwise supertest starts the server per request and
    // 20 parallel requests trip Node's MaxListeners warning.
    await ctx.app.listen(0);
  });
  beforeEach(() => resetDb(ctx.db));
  afterAll(() => ctx.app.close());

  const body = { externalOrderId: 'SHOP-1001', amount: 349, product: 'UC 600' };

  it('requires an Idempotency-Key on create', async () => {
    const res = await http().post('/api/orders').set(AUTH).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the stored response for a repeated key', async () => {
    const first = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000001').send(body);
    const second = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000001').send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await ctx.db.query('SELECT id FROM orders')).toHaveLength(1);
  });

  it('creates exactly one order when 20 identical requests race', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-race-0001').send(body),
      ),
    );
    // Each request either ran/replayed (201) or saw the first one still running (409, retry later).
    for (const r of results) expect([201, 409]).toContain(r.status);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await ctx.db.query('SELECT id FROM orders')).toHaveLength(1);
  });

  it('rejects the same key with a different body', async () => {
    await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000002').send(body);
    const res = await http()
      .post('/api/orders')
      .set(AUTH)
      .set('Idempotency-Key', 'key-0000002')
      .send({ ...body, amount: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('dedupes by externalOrderId even with a different key (natural key)', async () => {
    const a = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000003').send(body);
    const b = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000004').send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.created).toBe(false);
    expect(b.body.id).toBe(a.body.id);
  });

  it('stores validation errors too, so a replay gives the same error', async () => {
    const bad = { externalOrderId: 'has spaces', amount: -1 };
    const a = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000005').send(bad);
    const b = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000005').send(bad);
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
  });

  it('confirming payment twice queues the order once', async () => {
    const created = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000006').send(body);
    const id = created.body.id;

    const [p1, p2, p3] = await Promise.all([
      http().post(`/api/orders/${id}/payment-confirmed`).set(AUTH),
      http().post(`/api/orders/${id}/payment-confirmed`).set(AUTH),
      http().post(`/api/orders/${id}/payment-confirmed`).set(AUTH),
    ]);
    for (const r of [p1, p2, p3]) {
      expect(r.status).toBe(200);
      expect(r.body.order.status).toBe('QUEUED');
    }
    expect([p1, p2, p3].filter((r) => r.body.changed)).toHaveLength(1);
    const events = await statusEvents(ctx.db, id);
    expect(events.filter((e) => e.to === 'QUEUED')).toHaveLength(1);
  });

  it('refuses invalid transitions with 409', async () => {
    const created = await http().post('/api/orders').set(AUTH).set('Idempotency-Key', 'key-0000007').send(body);
    await http().post(`/api/orders/${created.body.id}/cancel`).set(AUTH).send({});
    const res = await http().post(`/api/orders/${created.body.id}/payment-confirmed`).set(AUTH);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'INVALID_TRANSITION', from: 'CANCELLED', to: 'QUEUED' });
  });
});
