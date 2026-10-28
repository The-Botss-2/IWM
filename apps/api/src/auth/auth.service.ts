import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AppAuth } from '@botss/auth';
import { rawPrisma } from '@botss/database';
import type { AccountType, SystemRole } from '@botss/shared-types';
import type { Request } from 'express';

import { AuthContextCache } from './auth-context-cache';
import { type AuthContext, buildAuthContext, loadAuthContextRows } from './auth-context';

/** Module-scoped singleton holding the Better Auth instance. */
let authInstance: AppAuth | null = null;

/** Called from `main.ts` after `createAuth(...)` completes, before NestJS init. */
export function setAuthInstance(auth: AppAuth): void {
  authInstance = auth;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly contextCache: AuthContextCache) {}

  get auth(): AppAuth {
    if (!authInstance) {
      throw new Error(
        'AuthService used before auth was initialized. Call setAuthInstance() in main.ts.',
      );
    }
    return authInstance;
  }

  /** Read the current Better Auth session from an Express-style request, or null. */
  async getSessionFromRequest(req: Request) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    return this.getSessionFromHeaders(headers);
  }

  /**
   * Resolve the Better Auth session for a set of request headers.
   *
   * Returns null ONLY when the caller genuinely has no valid session (missing,
   * expired or forged cookie). Infrastructure failures - Postgres pool
   * exhausted, connection reset, a timeout - throw a 503 instead. They used to
   * be swallowed into null, which AuthGuard turned into a 401, which the web
   * client read as "signed out" and bounced the user to the sign-in page even
   * though their cookie was perfectly valid.
   */
  async getSessionFromHeaders(headers: Headers) {
    try {
      const session = await this.auth.api.getSession({ headers });
      if (!session) {
        this.logger.debug('Better Auth returned null session (invalid or missing cookie).');
      }
      return session;
    } catch (err) {
      const status =
        (err as { status?: unknown; statusCode?: unknown })?.statusCode ??
        (err as { status?: unknown })?.status;
      // Better Auth raises APIError with a 4xx status for a malformed or
      // rejected cookie. That is an auth answer, not an outage.
      if (typeof status === 'number' && status >= 400 && status < 500) {
        this.logger.debug(`getSession rejected the cookie status=${status}`);
        return null;
      }
      this.logger.error(`getSession failed: ${(err as Error)?.message ?? 'unknown'}`);
      throw new ServiceUnavailableException({
        title: 'Service temporarily unavailable',
        status: 503,
        detail: "Couldn't verify your session right now. Please try again.",
        code: 'session-lookup-unavailable',
      });
    }
  }

  /**
   * Fetch the parts of the User row that downstream guards and the
   * CurrentOrganizationId decorator need (systemRole + organizationId).
   * Kept as a separate call so AuthGuard can resolve them with a single
   * round-trip per request alongside the session lookup.
   */
  async getUserOrgContext(userId: string): Promise<{
    // Sourced from the shared Zod enum rather than re-typed by hand. The
    // literal union that used to live here had to be widened by hand for HR
    // (2026-05), SUPER_ADMIN (2026-06) and FINANCE (2026-08), and silently
    // broke the build each time; this cannot drift.
    systemRole: SystemRole;
    organizationId: string | null;
    /** STAFF, or CLIENT for a client-portal account. AuthGuard confines a
     *  CLIENT account to `@PortalRoute()` handlers. */
    accountType: AccountType;
    /** Whether the user's organization is archived (soft-deleted) or
     *  suspended (`isActive=false`). When true, AuthGuard refuses the
     *  request and any cached session is invalidated downstream - keeps
     *  archived-tenant users out without a hard cascade delete. */
    orgInactive: boolean;
    /** True when the user row is soft-deleted (offboarded) or gone. The
     *  session row can outlive the user by up to 30 days, so AuthGuard must
     *  check this on every request rather than trusting the cookie. */
    userDisabled: boolean;
  }> {
    // rawPrisma bypasses the soft-delete extension on purpose: a soft-deleted
    // user must be SEEN here so we can refuse them, not silently not-found.
    const user = await rawPrisma.user.findUnique({
      where: { id: userId },
      select: {
        systemRole: true,
        organizationId: true,
        accountType: true,
        deletedAt: true,
        organization: { select: { deletedAt: true, isActive: true } },
      },
    });
    if (!user) {
      return {
        systemRole: 'EMPLOYEE',
        organizationId: null,
        accountType: 'STAFF',
        orgInactive: false,
        userDisabled: true,
      };
    }
    const orgInactive =
      !!user.organization &&
      (user.organization.deletedAt !== null || user.organization.isActive === false);
    return {
      systemRole: user.systemRole,
      organizationId: user.organizationId,
      accountType: user.accountType,
      orgInactive,
      userDisabled: user.deletedAt !== null,
    };
  }

  /**
   * Resolve everything AuthGuard needs for one request: the user/org flags
   * (same as `getUserOrgContext`), the active workspace + memberships, and
   * the effective permissions for that workspace.
   *
   * **Tenant boundary = Organization** (hard wall - no cross-org leaks).
   * **Read scope = explicit WorkspaceMembership** - no implicit
   * cross-workspace read for anyone, including admins. Private things
   * (personal mailboxes, DMs, personal todos, project channels you
   * weren't invited to) stay private even from a tenant admin.
   *
   * Admin powers exist as dedicated admin endpoints (list all users in
   * org, list all workspaces in org, archive an org, view audit log)
   * which have their own server-side role checks. They do NOT widen the
   * default scope, so a regular fetch through any feature service still
   * obeys the explicit-membership rule.
   *
   * Cross-org WorkspaceMembership rows (a legacy outside-collaborator
   * grant pointing at another tenant's workspace, or a row that survived
   * a tenant move) are dropped (see `buildAuthContext`) so the tenant wall
   * holds even if the underlying table has stale data.
   *
   * The per-user rows come from a short-TTL Redis cache (voided by every
   * membership / role / override / user / org write, see `AuthContextCache`)
   * or else from ONE stage of parallel queries. `fresh` skips the cache read;
   * AuthGuard uses it right after bootstrapping a workspace.
   */
  async resolveRequestContext(
    userId: string,
    requestedWorkspaceId?: string,
    opts: { fresh?: boolean } = {},
  ): Promise<AuthContext> {
    const cached = await this.contextCache.get(userId);
    let rows = opts.fresh ? null : cached.rows;
    if (!rows) {
      rows = await loadAuthContextRows(userId);
      await this.contextCache.set(userId, cached.epoch, rows);
    }
    return buildAuthContext(rows, requestedWorkspaceId);
  }

  /**
   * If the user has no workspace memberships, create a personal workspace and
   * make them a MEMBER of it. Idempotent.
   */
  async ensureBootstrapWorkspace(
    userId: string,
    userName: string,
    userEmail: string,
  ): Promise<string> {
    const existing = await rawPrisma.workspaceMembership.findFirst({
      where: { userId },
      select: { workspaceId: true },
    });
    if (existing) return existing.workspaceId;

    const baseSlug = (userEmail.split('@')[0] || userId)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const conflict = await rawPrisma.workspace.findUnique({
      where: { slug: baseSlug },
      select: { id: true },
    });
    const slug = conflict ? `${baseSlug}-${userId.slice(0, 6)}` : baseSlug;

    // Anchor the personal workspace to the user's organisation. A staff user
    // with no organisation must NOT fall back to the root (platform) org:
    // that would hand a stray account a workspace inside our own tenant.
    const u = await rawPrisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    if (!u?.organizationId) {
      this.logger.warn(`ensureBootstrapWorkspace refused: user ${userId} has no organization`);
      throw new ForbiddenException({
        title: 'No organization',
        status: 403,
        detail: 'This account is not attached to an organization. Ask an admin to invite you.',
        code: 'no-organization',
      });
    }
    const ws = await rawPrisma.workspace.create({
      data: {
        name: `${userName || userEmail}'s Workspace`,
        slug,
        ownerId: userId,
        organizationId: u.organizationId,
      },
    });
    await rawPrisma.workspaceMembership.create({
      // MEMBER, not OWNER: owning a workspace must not hand a new user
      // workspace-admin powers. Only affects new bootstraps.
      data: { workspaceId: ws.id, userId, role: 'MEMBER' },
    });
    return ws.id;
  }
}
