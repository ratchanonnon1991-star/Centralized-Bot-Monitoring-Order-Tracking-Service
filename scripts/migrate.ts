/**
 * Minimal migration runner (psql is not required).
 *
 * Applies, in order and exactly once each:
 *   001_candidate_pack  = db/schema.sql + db/seed.sql  (unchanged files from the pack)
 *   db/migrations/*.sql (sorted by file name)
 *
 * Usage: node dist/scripts/migrate.js
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

// Run from the project root (pnpm scripts do this), both compiled (dist/) and under ts-jest.
const DB_DIR = resolve(process.cwd(), 'db');
const MIGRATION_LOCK_ID = 7_420_001;

interface Migration {
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  const pack: Migration = {
    name: '001_candidate_pack',
    sql: readFileSync(join(DB_DIR, 'schema.sql'), 'utf8') + '\n' + readFileSync(join(DB_DIR, 'seed.sql'), 'utf8'),
  };
  const dir = join(DB_DIR, 'migrations');
  const rest = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
  return [pack, ...rest];
}

/** Names of every migration this code base expects to be applied, in order. */
export function migrationNames(): string[] {
  return loadMigrations().map((m) => m.name);
}

export async function runMigrations(databaseUrl: string, log: (msg: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Two processes starting at once must not both apply the same migration.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const m of loadMigrations()) {
      if (applied.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
        log(`applied ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('migrations up to date'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
