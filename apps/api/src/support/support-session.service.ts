import { Injectable, Logger } from '@nestjs/common';
import type { SupportSessionInfo } from '@botss/shared-types';

import { outsideRequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { supportSessionEnded, supportSessionInvalid, supportLogUnavailable } from './support-rules';
import { supportTokenSecret, verifySupportToken } from './support-token';

/** A support session that passed every check for this request. */
export interface ResolvedSupportSession extends SupportSessionInfo {
  /** Live workspaces of the granted organization, oldest first. */
  workspaceIds: string[];
}

/**
 * Per-request side of support access, called by AuthGuard for every request
 * that carries a support token. Nothing here caches: the grant is read from
 * the database on every request, so a revoke, the end time or a suspension
 * of the organization takes effect on the very next request.
 */
@Injectable()
export class SupportSessionService {
  private readonly logger = new Logger(SupportSessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check the token (signature, expiry, issued to this user and this sign-in
   * session) and that its grant is still active for an active organization.
   * Throws `support-session-invalid` or `support-session-ended`.
   */
  async resolve(args: {
    token: string;
    userId: string;
    sessionId: string;
    now: Date;
  }): Promise<ResolvedSupportSession> {
    const check = verifySupportToken(args.token, supportTokenSecret(), args.now);
    if (!check.ok) {
      throw check.reason === 'expired' ? supportSessionEnded() : supportSessionInvalid();
    }
    const { payload } = check;
    if (payload.u !== args.userId || payload.s !== args.sessionId) throw supportSessionInvalid();

    const grant = await this.prisma.client.supportGrant.findFirst({
      where: { id: payload.g, revokedAt: null, expiresAt: { gt: args.now } },
      select: {
        id: true,
        organizationId: true,
        expiresAt: true,
        readOnly: true,
        organization: {
          select: {
            name: true,
            isActive: true,
            deletedAt: true,
            workspaces: {
              where: { deletedAt: null },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    if (!grant || !grant.organization.isActive || grant.organization.deletedAt !== null) {
      throw supportSessionEnded();
    }
    return {
      grantId: grant.id,
      organizationId: grant.organizationId,
      organizationName: grant.organization.name,
      expiresAt: grant.expiresAt,
      readOnly: grant.readOnly,
      workspaceIds: grant.organization.workspaces.map((w) => w.id),
    };
  }

  /**
   * Record one support request in the granted organization's audit log:
   * actor = the super admin, metadata = method and path only (never bodies or
   * query strings). Unlike `AuditLogService.emit` this does NOT swallow
   * failures: a request that can't be logged is not run (503). Returns the
   * row id (null if the client returned none) for `markRefused`.
   */
  async recordAccess(
    session: Pick<ResolvedSupportSession, 'grantId' | 'organizationId'>,
    userId: string,
    request: { method: string; path: string; refused: boolean },
  ): Promise<string | null> {
    try {
      const row: { id?: string } | null = await this.prisma.client.auditLog.create({
        data: {
          organizationId: session.organizationId,
          actorUserId: userId,
          action: 'support.access',
          target: null,
          metadata: {
            method: request.method,
            path: request.path,
            ...(request.refused ? { refused: true } : {}),
          },
        },
        select: { id: true },
      });
      return row?.id ?? null;
    } catch (err) {
      this.logger.error(
        `support.access log failed org=${session.organizationId} grant=${session.grantId} ` +
          `message=${(err as Error)?.message ?? 'unknown'}`,
      );
      throw supportLogUnavailable();
    }
  }

  /**
   * Mark an access row `refused: true` once the response says a later guard
   * or the service refused the request (401/403). Runs after the response,
   * outside the request's store, so the support write backstop does not
   * apply to this one update. Never throws.
   */
  async markRefused(
    session: Pick<ResolvedSupportSession, 'grantId' | 'organizationId'>,
    accessLogId: string,
    request: { method: string; path: string },
  ): Promise<void> {
    try {
      // Prisma queries are lazy and run on `then`, so `then` is called inside
      // the callback too: the query must start outside the request's store.
      await outsideRequestContext(() =>
        this.prisma.client.auditLog
          .updateMany({
            where: {
              id: accessLogId,
              organizationId: session.organizationId,
              action: 'support.access',
            },
            data: { metadata: { method: request.method, path: request.path, refused: true } },
          })
          .then((result) => result),
      );
    } catch (err) {
      this.logger.warn(
        `support.access refused mark failed org=${session.organizationId} grant=${session.grantId} ` +
          `message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }
}
