import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../common/events.service';
import { DbService, Queryable } from '../db/db.service';

export interface KillSwitchState {
  /** true = whole system stopped: no bot may take a new order. */
  engaged: boolean;
  reason: string | null;
  updatedBy: string;
  updatedAt: Date;
}

@Injectable()
export class SystemService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  /**
   * With a lock, the row stays locked until the caller's transaction ends.
   * Dispatch takes 'share' so flipping the switch (an UPDATE) waits for in-flight claims,
   * and every claim that starts after the flip sees it. Flips take 'update' so two
   * operators clicking at once are serialized and each sees the other's result.
   */
  async getKillSwitch(q: Queryable = this.db.pool, lock: 'share' | 'update' | null = null): Promise<KillSwitchState> {
    const lockClause = lock === 'share' ? 'FOR SHARE' : lock === 'update' ? 'FOR UPDATE' : '';
    const { rows } = await q.query(
      `SELECT value, updated_by, updated_at FROM system_settings WHERE key = 'kill_switch' ${lockClause}`,
    );
    const row = rows[0];
    if (!row) throw new Error('kill_switch setting missing - run migrations');
    return {
      engaged: row.value.engaged === true,
      reason: row.value.reason ?? null,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  /** Setting the state it already has is a no-op: no write, no audit entry, no broadcast. */
  async setKillSwitch(engaged: boolean, reason: string | null, actor: string): Promise<KillSwitchState> {
    const { state, changed } = await this.db.tx(async (c) => {
      const before = await this.getKillSwitch(c, 'update');
      if (before.engaged === engaged) return { state: before, changed: false };
      const { rows } = await c.query(
        `UPDATE system_settings SET value = $1, updated_by = $2, updated_at = now()
          WHERE key = 'kill_switch' RETURNING updated_by, updated_at`,
        [{ engaged, reason }, actor],
      );
      await this.audit.log(c, {
        actor,
        action: engaged ? 'KILL_SWITCH_ENGAGED' : 'KILL_SWITCH_RELEASED',
        targetType: 'system',
        targetId: 'kill_switch',
        metadata: { reason },
      });
      return { state: { engaged, reason, updatedBy: rows[0].updated_by, updatedAt: rows[0].updated_at }, changed: true };
    });
    if (!changed) return state;
    this.events.emit('killSwitch', state.engaged);
    this.events.emit('changed', 'system');
    if (!state.engaged) this.events.emit('orderQueued');
    return state;
  }
}
