import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CommandDto, CommandsService } from '../bots/commands.service';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../common/events.service';
import { AppConfig } from '../config/app-config';
import { DbService } from '../db/db.service';

interface DeploymentRow {
  id: string;
  version: string;
  file_name: string;
  storage_path: string;
  size_bytes: string;
  sha256: string;
  uploaded_by: string;
  created_at: Date;
}

function toDto(r: DeploymentRow) {
  return {
    id: Number(r.id),
    version: r.version,
    fileName: r.file_name,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    downloadPath: `/api/deployments/${r.id}/download`,
  };
}
export type DeploymentDto = ReturnType<typeof toDto>;

export type RolloutTarget =
  | { botId: string; outcome: 'queued'; command: CommandDto }
  | { botId: string; outcome: 'already-pending'; command: CommandDto }
  | { botId: string; outcome: 'up-to-date' }
  | { botId: string; outcome: 'unknown-bot' };

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Write to a temp name and rename, so a half-written file is never served. The temp name is
 * unique per call: the same package uploaded twice at once must not share it.
 */
async function writeAtomically(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.part`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, path);
  } catch (err) {
    // A concurrent upload of the same bytes already put an identical file there (Windows refuses
    // to replace a file another request is still renaming or serving).
    await rm(tmp, { force: true });
    if (!(await exists(path))) throw err;
  }
}

// Local file header, or end-of-central-directory for an empty archive.
const ZIP_MAGIC = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly db: DbService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Stores a code package. Uploading the same bytes twice returns the existing package (dedupe by sha256).
   * If that package's file was lost from disk (e.g. a host that wipes its disk on redeploy), the
   * re-upload puts it back, so bots can download it again.
   */
  async upload(fileName: string, data: Buffer, actor: string): Promise<{ deployment: DeploymentDto; created: boolean }> {
    if (!fileName.toLowerCase().endsWith('.zip') || !ZIP_MAGIC.some((m) => data.subarray(0, 4).equals(m))) {
      throw new BadRequestException({ error: 'INVALID_PACKAGE', message: 'Package must be a .zip file' });
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    const existing = await this.db.query<DeploymentRow>(`SELECT * FROM deployments WHERE sha256 = $1`, [sha256]);
    if (existing[0]) {
      const row = existing[0];
      if (!(await exists(row.storage_path))) {
        // Several re-uploads at once: the advisory lock lets one restore (and audit) it, the rest see the file.
        await this.db.tx(async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtext('deployment-file:' || $1))`, [row.id]);
          if (await exists(row.storage_path)) return;
          await writeAtomically(row.storage_path, data);
          await this.audit.log(c, {
            actor,
            action: 'DEPLOYMENT_FILE_RESTORED',
            targetType: 'deployment',
            targetId: row.id,
            metadata: { version: row.version },
          });
        });
      }
      return { deployment: toDto(row), created: false };
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const version = `oxide-${stamp}-${sha256.slice(0, 6)}`;
    const storagePath = join(resolve(this.config.deployStorageDir), `${version}.zip`);
    await writeAtomically(storagePath, data);

    const result = await this.db.tx(async (c) => {
      const { rows } = await c.query<DeploymentRow>(
        `INSERT INTO deployments (version, file_name, storage_path, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sha256) DO NOTHING
         RETURNING *`,
        [version, basename(fileName).slice(0, 200), storagePath, data.length, sha256, actor],
      );
      if (!rows[0]) {
        // A concurrent upload of the same bytes won the race.
        const { rows: winner } = await c.query<DeploymentRow>(`SELECT * FROM deployments WHERE sha256 = $1`, [sha256]);
        return { row: winner[0], created: false };
      }
      await this.audit.log(c, {
        actor,
        action: 'DEPLOYMENT_UPLOADED',
        targetType: 'deployment',
        targetId: rows[0].id,
        metadata: { version, sizeBytes: data.length, sha256 },
      });
      return { row: rows[0], created: true };
    });
    // The loser of a race (other second -> other version name) leaves no orphan file behind.
    if (!result.created && result.row.storage_path !== storagePath) await rm(storagePath, { force: true });
    if (result.created) this.events.emit('changed', 'deployments');
    return { deployment: toDto(result.row), created: result.created };
  }

  async list(limit = 20): Promise<DeploymentDto[]> {
    const rows = await this.db.query<DeploymentRow>(`SELECT * FROM deployments ORDER BY id DESC LIMIT $1`, [limit]);
    return rows.map(toDto);
  }

  async latest(): Promise<DeploymentDto | null> {
    return (await this.list(1))[0] ?? null;
  }

  async get(id: number): Promise<DeploymentDto & { storagePath: string }> {
    const rows = await this.db.query<DeploymentRow>(`SELECT * FROM deployments WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'DEPLOYMENT_NOT_FOUND' });
    return { ...toDto(rows[0]), storagePath: rows[0].storage_path };
  }

  /**
   * Queues an `update` command for each target bot (all bots when botIds is omitted).
   * Re-running a rollout does not stack commands: bots already on this version or with
   * the same update still pending are reported, not re-queued.
   */
  async rollout(id: number, botIds: string[] | undefined, actor: string) {
    const deployment = await this.get(id);
    // other_update_pending: the bot runs this version now, but an update to another package is
    // still queued - it is not up to date, because that update would replace this version.
    const bots = await this.db.query<{ id: string; code_version: string | null; other_update_pending: boolean }>(
      `SELECT b.id, b.code_version,
              EXISTS (SELECT 1 FROM oxide_bot_commands c
                       WHERE c.bot_id = b.id AND c.command = 'update' AND c.status IN ('queued','running')
                         AND c.payload->>'deploymentId' <> $1) AS other_update_pending
         FROM oxide_bot_agents b ORDER BY b.id`,
      [String(deployment.id)],
    );
    const known = new Map(bots.map((b) => [b.id, b]));
    const targets = botIds ?? bots.map((b) => b.id);

    const results: RolloutTarget[] = [];
    for (const botId of [...new Set(targets)]) {
      const bot = known.get(botId);
      if (!bot) {
        results.push({ botId, outcome: 'unknown-bot' });
        continue;
      }
      if (bot.code_version === deployment.version && !bot.other_update_pending) {
        results.push({ botId, outcome: 'up-to-date' });
        continue;
      }
      const { command, created } = await this.commands.createUnlessOpen(
        botId,
        'update',
        {
          deploymentId: deployment.id,
          version: deployment.version,
          sha256: deployment.sha256,
          sizeBytes: deployment.sizeBytes,
          downloadPath: deployment.downloadPath,
        },
        actor,
        'deploymentId',
      );
      results.push({ botId, outcome: created ? 'queued' : 'already-pending', command });
    }
    await this.audit.log(this.db.pool, {
      actor,
      action: 'DEPLOYMENT_ROLLOUT',
      targetType: 'deployment',
      targetId: String(deployment.id),
      metadata: { version: deployment.version, targets: results.map((r) => ({ botId: r.botId, outcome: r.outcome })) },
    });
    const { storagePath: _ignored, ...publicDeployment } = deployment;
    return { deployment: publicDeployment, targets: results };
  }
}
