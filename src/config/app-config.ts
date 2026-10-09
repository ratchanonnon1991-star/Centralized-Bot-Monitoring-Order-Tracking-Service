import { Global, Module } from '@nestjs/common';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export class AppConfig {
  port!: number;
  databaseUrl!: string;
  botSimulatorUrl!: string | null;
  adminToken!: string;
  agentToken!: string;
  heartbeatTimeoutMs!: number;
  orderRequeueAfterMs!: number;
  /** IN_PROGRESS longer than this (bot alive but stuck) is taken back and retried. 0 = off. */
  orderMaxProcessingMs!: number;
  orderMaxAttempts!: number;
  retryBaseDelayMs!: number;
  /**
   * After a retry becomes claimable, the bot that held the previous attempt must wait this much
   * longer before it may take the order again - other bots get the first chance.
   */
  retrySameBotAfterMs!: number;
  commandTimeoutMs!: number;
  monitorIntervalMs!: number;
  deployStorageDir!: string;
  maxUploadBytes!: number;
  /** Background loops (heartbeat monitor). Tests turn this off and call tick() themselves. */
  backgroundJobs!: boolean;

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
    return Object.assign(new AppConfig(), {
      port: int(env, 'PORT', 3001),
      databaseUrl: required(env, 'DATABASE_URL'),
      botSimulatorUrl: env.BOT_SIMULATOR_URL || null,
      adminToken: required(env, 'ADMIN_TOKEN'),
      agentToken: required(env, 'AGENT_TOKEN'),
      heartbeatTimeoutMs: int(env, 'HEARTBEAT_TIMEOUT_MS', 10_000),
      orderRequeueAfterMs: int(env, 'ORDER_REQUEUE_AFTER_MS', 20_000),
      orderMaxProcessingMs: int(env, 'ORDER_MAX_PROCESSING_MS', 300_000),
      orderMaxAttempts: int(env, 'ORDER_MAX_ATTEMPTS', 3),
      retryBaseDelayMs: int(env, 'RETRY_BASE_DELAY_MS', 2_000),
      retrySameBotAfterMs: int(env, 'RETRY_SAME_BOT_AFTER_MS', 10_000),
      commandTimeoutMs: int(env, 'COMMAND_TIMEOUT_MS', 15_000),
      monitorIntervalMs: int(env, 'MONITOR_INTERVAL_MS', 2_000),
      deployStorageDir: env.DEPLOY_STORAGE_DIR || './storage/deployments',
      maxUploadBytes: int(env, 'MAX_UPLOAD_MB', 50) * 1024 * 1024,
      backgroundJobs: env.BACKGROUND_JOBS !== 'false',
    });
  }
}

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => AppConfig.fromEnv() }],
  exports: [AppConfig],
})
export class ConfigModule {}
