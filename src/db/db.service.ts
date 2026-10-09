import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { migrationNames } from '../../scripts/migrate';
import { AppConfig } from '../config/app-config';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;

  constructor(private readonly config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
    this.pool.on('error', (err) => this.logger.error(`idle client error: ${err.message}`));
  }

  /**
   * Fail fast at startup instead of serving 500s: the database must be reachable and every
   * migration in db/ must have been applied (a forgotten `pnpm db:migrate` otherwise shows up
   * later as "column does not exist" in the middle of a dispatch).
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.checkDatabase();
    } catch (err) {
      // Nest does not run onModuleDestroy when init fails: close the pool here, or its idle
      // connections keep the process (and test runners) alive.
      await this.pool.end().catch(() => undefined);
      throw err;
    }
  }

  private async checkDatabase(): Promise<void> {
    const where = (() => {
      try {
        const u = new URL(this.config.databaseUrl);
        return `${u.hostname}:${u.port || 5432}${u.pathname}`;
      } catch {
        return 'DATABASE_URL';
      }
    })();
    let applied: Set<string>;
    try {
      const { rows } = await this.pool.query<{ name: string }>(`SELECT name FROM schema_migrations`);
      applied = new Set(rows.map((r) => r.name));
    } catch (err) {
      const e = err as Error & { code?: string; errors?: Array<{ code?: string; message?: string }> };
      if (e.code === '42P01') {
        applied = new Set(); // schema_migrations does not exist yet
      } else {
        // A refused connection is an AggregateError (IPv4 + IPv6 attempts) with an empty message.
        const reason = e.message || e.code || e.errors?.[0]?.code || e.errors?.[0]?.message || String(err);
        throw new Error(`Cannot reach PostgreSQL at ${where}: ${reason} - is it running? (pnpm db:up)`);
      }
    }
    const missing = migrationNames().filter((name) => !applied.has(name));
    if (missing.length) {
      throw new Error(`Database ${where} is missing migrations ${missing.join(', ')} - run: pnpm db:migrate`);
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  /** Runs fn in a READ COMMITTED transaction; row locks inside fn decide concurrency. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A connection whose ROLLBACK failed is in an unknown state: destroy it instead of pooling it.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((e: Error) => (broken = e));
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [DbService], exports: [DbService] })
export class DbModule {}
