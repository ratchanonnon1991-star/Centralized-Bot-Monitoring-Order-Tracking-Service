import { Injectable } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';

export interface AuditEntry {
  actor: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Pass the transaction client so the audit row commits (or rolls back) with the change it describes. */
  async log(q: Queryable, e: AuditEntry): Promise<void> {
    await q.query(
      `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5)`,
      [e.actor, e.action, e.targetType, e.targetId ?? null, e.metadata ?? null],
    );
  }

  async list(limit: number, targetType?: string, targetId?: string) {
    const rows = await this.db.query(
      `SELECT id, actor, action, target_type, target_id, metadata, created_at
         FROM audit_logs
        WHERE ($2::text IS NULL OR target_type = $2) AND ($3::text IS NULL OR target_id = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit, targetType ?? null, targetId ?? null],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      actor: r.actor,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  }
}
