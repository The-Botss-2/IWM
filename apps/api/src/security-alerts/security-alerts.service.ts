import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { setSoftDeleteListener } from '@botss/database';

import { AuditLogService } from '../audit-log/audit-log.service';
import { currentRequestAuth } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { deleteCountingSuppressed } from './delete-counting';
import { setSignInFailureSink } from './sign-in-failure-sink';

/** Thresholds and windows. Counts only; nothing here is org specific. */
export const SECURITY_ALERT_RULES = {
  failedSignins: { threshold: 20, windowSeconds: 60 * 60 },
  massDelete: { threshold: 50, windowSeconds: 10 * 60 },
  largeRows: 500,
} as const;

/**
 * Raises security alerts as audit rows in the affected organization (they
 * appear in the platform log too). Hard rules: a failure here is logged and
 * swallowed, never thrown into the request, and metadata holds counts, the
 * window and a user id only - never an email, password or content.
 */
@Injectable()
export class SecurityAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityAlertsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  onModuleInit(): void {
    setSignInFailureSink((email) => void this.recordFailedSignIn(email));
    setSoftDeleteListener(({ count }) => void this.recordDeletes(count));
  }

  onModuleDestroy(): void {
    setSignInFailureSink(null);
    setSoftDeleteListener(null);
  }

  /** A sign-in failed for `email`. Counted per organization of that account. */
  async recordFailedSignIn(email: string): Promise<void> {
    try {
      const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!normalized) return;
      const user = await this.prisma.client.user.findFirst({
        where: { email: normalized },
        select: { organizationId: true },
      });
      const organizationId = user?.organizationId;
      if (!organizationId) return;
      const rule = SECURITY_ALERT_RULES.failedSignins;
      const count = await this.bump(`sec:signin:${organizationId}`, 1, rule.windowSeconds);
      if (count < rule.threshold) return;
      if (!(await this.claimAlert(`sec:signin:alerted:${organizationId}`, rule.windowSeconds))) return;
      await this.audit.emit({
        organizationId,
        actorUserId: null,
        action: 'security.failed_signins',
        metadata: { count, windowMinutes: rule.windowSeconds / 60 },
      });
    } catch (err) {
      this.warn('failed_signins', err);
    }
  }

  /** `count` rows were just soft-deleted in the current request. */
  async recordDeletes(count: number): Promise<void> {
    try {
      if (deleteCountingSuppressed()) return;
      const auth = currentRequestAuth();
      if (!auth?.organizationId) return;
      const rule = SECURITY_ALERT_RULES.massDelete;
      const total = await this.bump(`sec:delete:${auth.userId}`, count, rule.windowSeconds);
      if (total < rule.threshold) return;
      if (!(await this.claimAlert(`sec:delete:alerted:${auth.userId}`, rule.windowSeconds))) return;
      await this.audit.emit({
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'security.mass_delete',
        metadata: { count: total, windowMinutes: rule.windowSeconds / 60, userId: auth.userId },
      });
    } catch (err) {
      this.warn('mass_delete', err);
    }
  }

  /** A person was given an admin level role (callers skip unchanged roles). */
  async recordNewAdmin(args: {
    organizationId: string;
    actorUserId: string | null;
    userId: string;
    scope: 'system' | 'workspace';
    role: string;
  }): Promise<void> {
    try {
      await this.audit.emit({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        action: 'security.new_admin',
        target: `user:${args.userId}`,
        metadata: { userId: args.userId, scope: args.scope, role: args.role },
      });
    } catch (err) {
      this.warn('new_admin', err);
    }
  }

  /** A file with `rows` rows was exported by `userId`. */
  async recordExport(userId: string, rows: number): Promise<void> {
    await this.recordLarge('security.large_export', userId, rows);
  }

  /** A sheet with `rows` rows was imported by `userId`. */
  async recordImport(userId: string, rows: number): Promise<void> {
    await this.recordLarge('security.large_import', userId, rows);
  }

  private async recordLarge(
    action: 'security.large_export' | 'security.large_import',
    userId: string,
    rows: number,
  ): Promise<void> {
    try {
      if (rows < SECURITY_ALERT_RULES.largeRows) return;
      const user = await this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { organizationId: true },
      });
      if (!user?.organizationId) return;
      await this.audit.emit({
        organizationId: user.organizationId,
        actorUserId: userId,
        action,
        metadata: { rows, threshold: SECURITY_ALERT_RULES.largeRows, userId },
      });
    } catch (err) {
      this.warn(action, err);
    }
  }

  /**
   * Add `by` to a windowed counter. The increment and the TTL go in one
   * MULTI so a counter can never be left without an expiry; `NX` sets the
   * TTL only when the window opens. Returns 0 (below any threshold) while
   * Redis is not connected, so nothing queues behind a dead connection.
   */
  // Requires Redis 7 or newer (EXPIRE ... NX); the compose files pin redis:7.
  private async bump(key: string, by: number, windowSeconds: number): Promise<number> {
    const client = this.redis.client;
    if (client.status !== 'ready') return 0;
    const replies = await client.multi().incrby(key, by).expire(key, windowSeconds, 'NX').exec();
    const [incrErr, rawTotal] = replies?.[0] ?? [new Error('no reply'), 0];
    if (incrErr) throw incrErr;
    const total = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal);
    return total;
  }

  /** True for the first caller in a window; later callers get false. */
  private async claimAlert(key: string, windowSeconds: number): Promise<boolean> {
    const client = this.redis.client;
    if (client.status !== 'ready') return false;
    const set = await client.set(key, '1', 'EX', windowSeconds, 'NX');
    return set === 'OK';
  }

  /** Logs the error's name and code only: messages can carry keys or ids. */
  private warn(kind: string, err: unknown): void {
    const e = err as { name?: unknown; code?: unknown } | null;
    const name = typeof e?.name === 'string' ? e.name : 'unknown';
    const code = typeof e?.code === 'string' || typeof e?.code === 'number' ? ` code=${e.code}` : '';
    this.logger.warn(`security alert ${kind} skipped error=${name}${code}`);
  }
}
