-- 002: Bot control center + order state machine
--
-- db/schema.sql and db/seed.sql from the candidate pack are applied unchanged (as "001").
-- This migration extends them with what the spec needs and the pack lacks:
--   * order states from the spec (PENDING_PAYMENT -> QUEUED -> IN_PROGRESS -> COMPLETED, DELAYED, FAILED)
--   * dispatch / retry bookkeeping on orders (assigned bot, attempt fencing token, backoff)
--   * bot enable flag, host, code version, latest result
--   * 'update' command, kill-switch, deployment packages, idempotency keys, bot logs

-- ---------------------------------------------------------------------------
-- Orders: state machine
-- ---------------------------------------------------------------------------
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

-- Map the pack's lowercase states. 'processing' had no bot assigned, so the safe
-- choice is to put it back in the queue rather than invent an assignment.
UPDATE orders SET status = CASE status
  WHEN 'pending'    THEN 'PENDING_PAYMENT'
  WHEN 'processing' THEN 'QUEUED'
  WHEN 'completed'  THEN 'COMPLETED'
  WHEN 'failed'     THEN 'FAILED'
  WHEN 'cancelled'  THEN 'CANCELLED'
  ELSE status
END;

ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'PENDING_PAYMENT';
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
  ('PENDING_PAYMENT','QUEUED','IN_PROGRESS','DELAYED','COMPLETED','FAILED','CANCELLED'));

ALTER TABLE orders
  ADD COLUMN product         TEXT,
  ADD COLUMN customer_ref    TEXT,
  ADD COLUMN assigned_bot_id TEXT REFERENCES oxide_bot_agents(id),
  -- incremented on every claim; doubles as a fencing token so a stale bot
  -- cannot complete an attempt that was already taken away from it
  ADD COLUMN attempt_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts    INT NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN started_at      TIMESTAMPTZ,
  ADD COLUMN delayed_at      TIMESTAMPTZ,
  ADD COLUMN completed_at    TIMESTAMPTZ,
  ADD COLUMN last_error      TEXT,
  ADD COLUMN result          JSONB;

ALTER TABLE orders ADD CONSTRAINT orders_active_has_bot_check
  CHECK (status NOT IN ('IN_PROGRESS','DELAYED') OR assigned_bot_id IS NOT NULL);

-- A bot works on at most one order at a time - enforced by the database,
-- not only by application code.
CREATE UNIQUE INDEX uq_orders_one_active_per_bot ON orders(assigned_bot_id)
  WHERE status IN ('IN_PROGRESS','DELAYED');

-- Dispatch queue scan: FIFO by creation time (backoff filtered on next_attempt_at).
CREATE INDEX idx_orders_queue ON orders(created_at, id) WHERE status = 'QUEUED';

UPDATE orders SET next_attempt_at = now() WHERE status = 'QUEUED' AND next_attempt_at IS NULL;

-- ---------------------------------------------------------------------------
-- Bots
-- ---------------------------------------------------------------------------
ALTER TABLE oxide_bot_agents
  ADD COLUMN enabled             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN host_name           TEXT,
  ADD COLUMN code_version        TEXT,
  ADD COLUMN connected_at        TIMESTAMPTZ,
  ADD COLUMN last_result         TEXT CHECK (last_result IN ('done','failed')),
  ADD COLUMN last_result_summary TEXT,
  ADD COLUMN last_result_at      TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Commands: add 'update' + delivery bookkeeping
-- ---------------------------------------------------------------------------
ALTER TABLE oxide_bot_commands DROP CONSTRAINT IF EXISTS oxide_bot_commands_command_check;
ALTER TABLE oxide_bot_commands ADD CONSTRAINT oxide_bot_commands_command_check
  CHECK (command IN ('start','stop','restart','status','update'));

ALTER TABLE oxide_bot_commands
  ADD COLUMN payload           JSONB,
  ADD COLUMN transport         TEXT CHECK (transport IN ('agent','simulator')),
  ADD COLUMN dispatched_at     TIMESTAMPTZ,
  ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0;

CREATE INDEX idx_commands_open ON oxide_bot_commands(bot_id, id) WHERE status IN ('queued','running');

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------
CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES ('kill_switch', '{"engaged": false, "reason": null}');

CREATE TABLE deployments (
  id           BIGSERIAL PRIMARY KEY,
  version      TEXT UNIQUE NOT NULL,
  file_name    TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  sha256       CHAR(64) UNIQUE NOT NULL,
  uploaded_by  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    CHAR(64) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('processing','completed')),
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (scope, key)
);

CREATE TABLE bot_logs (
  id         BIGSERIAL PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES oxide_bot_agents(id),
  level      TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bot_logs_bot_created ON bot_logs(bot_id, created_at DESC);
