import 'dotenv/config';
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from '../../scripts/migrate';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { BotsService } from '../../src/bots/bots.service';
import { CommandsService } from '../../src/bots/commands.service';
import { AppConfig } from '../../src/config/app-config';
import { DbService } from '../../src/db/db.service';
import { HeartbeatMonitorService } from '../../src/monitor/heartbeat-monitor.service';
import { DispatchService } from '../../src/orders/dispatch.service';
import { OrdersService } from '../../src/orders/orders.service';
import { SystemService } from '../../src/system/system.service';

export const ADMIN = 'test-admin-token';
export const AGENT = 'test-agent-token';
export const AUTH = { Authorization: `Bearer ${ADMIN}` };

/** Tests use their own database next to the dev one, so they never touch dev data. */
function testDbUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set - copy .env.example to .env');
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/oxide_monitor_test';
  return u.toString();
}

let prepared = false;
async function prepareDatabase(url: string): Promise<void> {
  if (prepared) return;
  const name = new URL(url).pathname.slice(1);
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rows.length) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  await admin.end();
  await runMigrations(url, () => undefined);
  prepared = true;
}

export interface TestContext {
  app: INestApplication;
  config: AppConfig;
  db: DbService;
  orders: OrdersService;
  dispatch: DispatchService;
  bots: BotsService;
  commands: CommandsService;
  system: SystemService;
  monitor: HeartbeatMonitorService;
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const url = testDbUrl();
  await prepareDatabase(url);
  const config = Object.assign(
    AppConfig.fromEnv({
      DATABASE_URL: url,
      ADMIN_TOKEN: ADMIN,
      AGENT_TOKEN: AGENT,
      BOT_SIMULATOR_URL: '',
      BACKGROUND_JOBS: 'false', // tests drive the monitor by calling tick()
      RETRY_BASE_DELAY_MS: '0',
      DEPLOY_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'oxide-deploy-')),
    }),
    overrides,
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return {
    app,
    config,
    db: app.get(DbService),
    orders: app.get(OrdersService),
    dispatch: app.get(DispatchService),
    bots: app.get(BotsService),
    commands: app.get(CommandsService),
    system: app.get(SystemService),
    monitor: app.get(HeartbeatMonitorService),
  };
}

/** Back to the seed state: 3 bots online and enabled, no orders, kill-switch released. */
export async function resetDb(db: DbService): Promise<void> {
  await db.query(
    `TRUNCATE order_events, orders, oxide_bot_commands, audit_logs, idempotency_keys, bot_logs, deployments RESTART IDENTITY CASCADE`,
  );
  await db.query(`DELETE FROM oxide_bot_agents WHERE id NOT IN ('bot-01','bot-02','bot-03')`);
  await db.query(
    `UPDATE oxide_bot_agents SET status = 'online', enabled = true, last_heartbeat = now(),
       code_version = NULL, last_result = NULL, last_result_summary = NULL, last_result_at = NULL`,
  );
  await db.query(`UPDATE system_settings SET value = '{"engaged": false, "reason": null}' WHERE key = 'kill_switch'`);
}

export async function addBots(db: DbService, ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.query(
      `INSERT INTO oxide_bot_agents (id, name, device_name, status, last_heartbeat) VALUES ($1, $1, $1, 'online', now())`,
      [id],
    );
  }
}

let seq = 0;
/** Creates an order and confirms payment, so it is QUEUED and claimable. */
export async function queuedOrder(ctx: TestContext, maxAttempts?: number): Promise<number> {
  const { order } = await ctx.orders.create({ externalOrderId: `T-${Date.now()}-${seq++}`, amount: 100 }, 'test');
  if (maxAttempts) await ctx.db.query(`UPDATE orders SET max_attempts = $2 WHERE id = $1`, [order.id, maxAttempts]);
  await ctx.orders.confirmPayment(order.id, 'test');
  return order.id;
}

export async function orderRow(db: DbService, id: number) {
  const [row] = await db.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return row;
}

export async function statusEvents(db: DbService, id: number) {
  const rows = await db.query(
    `SELECT payload FROM order_events WHERE order_id = $1 AND event_type = 'STATUS_CHANGED' ORDER BY id`,
    [id],
  );
  return rows.map((r) => r.payload as { from: string; to: string; reason: string; botId: string });
}
