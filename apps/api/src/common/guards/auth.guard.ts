import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SUPPORT_SESSION_PERMISSIONS, type EffectivePermissions } from '@botss/auth';
import {
  SUPPORT_TOKEN_HEADER,
  type AccountType,
  type SupportSessionInfo,
  type SystemRole,
} from '@botss/shared-types';

import type { AuthContext } from '../../auth/auth-context';
import { AuthService } from '../../auth/auth.service';
import { ROOT_ORG_ID } from '../../organizations/organizations.constants';
import { SupportSessionService } from '../../support/support-session.service';
import {
  isSupportExcludedPath,
  isSupportReadMethod,
  supportAccessPath,
  supportExcluded,
  supportLogUnavailable,
  supportNotAllowed,
  supportReadOnly,
  supportSessionInvalid,
} from '../../support/support-rules';
import { isSupportRequest, markSupportRequest, setRequestAuth } from '../request-context';
import {
  SUPPORT_TOKEN_QUERY_KEY,
  SUPPORT_TOKEN_QUERY_PARAM,
} from '../decorators/support-token-query.decorator';
import {
  PORTAL_ROUTE_KEY,
  portalBoundary,
  type PortalRouteAudience,
} from '../decorators/portal-route.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    // Optional so a wiring regression can only refuse support requests
    // (see activateSupportSession), never change a normal request.
    @Optional() private readonly supportSessions?: SupportSessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.reflector || !this.authService) {
      const logger = new Logger('AuthGuard');
      logger.error(
        'Critical dependencies (Reflector or AuthService) are missing in AuthGuard. Failing safe to unauthorized.',
      );
      throw new UnauthorizedException('Authentication system is currently unavailable.');
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & RequestExtensions>();
    const session = await this.authService.getSessionFromRequest(req);

    if (!session) {
      // Never log raw headers here - they include the session Cookie and
      // would let anyone with log access replay a live session. Method + path
      // is enough to debug an unauthenticated request. The query string is
      // left out too: it can carry a support token (`?st=`).
      this.logger.warn(
        `No session for ${req.method} ${supportAccessPath(req.originalUrl ?? req.url)}`,
      );
      throw new UnauthorizedException({
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required.',
        code: 'unauthenticated',
      });
    }

    const requestedWorkspaceId = req.headers['x-workspace-id'];
    const wsId = typeof requestedWorkspaceId === 'string' ? requestedWorkspaceId : undefined;

    // Read only support session. Only a request that carries the header (or,
    // on a route marked `@SupportTokenInQuery()`, the `?st=` parameter) takes
    // this branch; every other request continues below exactly as before.
    const supportToken = this.supportTokenOf(ctx, req);
    if (supportToken !== undefined) {
      return this.activateSupportSession(ctx, req, session, supportToken, wsId);
    }

    // Pull org/systemRole, memberships and effective permissions in ONE
    // resolution (one stage of parallel queries, or the short-TTL Redis
    // cache) so downstream guards (GlobalAdmin, WorkspaceRole) and the
    // CurrentOrganizationId decorator can read them without re-querying. The
    // session itself doesn't carry these fields.
    let context: AuthContext;
    try {
      context = await this.authService.resolveRequestContext(session.user.id, wsId);
    } catch (err) {
      this.logger.error(`Auth context resolution failed: ${(err as Error).message}`);
      throw contextUnavailable();
    }
    const userExtras = context.extras;

    // Offboarded users: the Better Auth session row survives a soft delete, so
    // the cookie alone is not proof the account is still allowed in.
    if (userExtras.userDisabled) throw accountDisabled();

    // Tenant suspension: if the user's organization is soft-deleted or marked
    // inactive, reject every request. Soft-delete now means "block sign-in
    // and hide data" - the reversible side of the dual-delete contract. The
    // user's session is left intact so a future restore brings them back
    // without a re-auth, but every request 401s while the org is suspended.
    if (userExtras.orgInactive) throw organizationSuspended();

    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? '',
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
      systemRole: userExtras.systemRole,
      organizationId: userExtras.organizationId,
      accountType: userExtras.accountType,
    };
    req.sessionId = session.session.id;

    // Client-portal boundary. A CLIENT account is confined to handlers marked
    // `@PortalRoute()` and never gets workspace context: no memberships, and
    // above all no `ensureBootstrapWorkspace`, which would hand it a personal
    // workspace as OWNER (`manage all`). Deny by default means every new
    // internal endpoint is closed to clients without anyone remembering to.
    const audience = this.reflector.getAllAndOverride<PortalRouteAudience | undefined>(
      PORTAL_ROUTE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const boundary = portalBoundary(userExtras.accountType, audience);
    if (boundary === 'deny-client') throw portalOnly();
    if (boundary === 'deny-staff') throw clientPortalOnly();
    if (boundary === 'client') {
      req.workspaceId = null;
      req.workspaceMemberships = [];
      req.projectMemberships = [];
      req.permissions = { company: [], workspace: [] };
      return true;
    }

    // Memberships and permissions were resolved together with the user above.
    try {
      if (context.session.workspaceMemberships.length === 0) {
        // First authenticated request for this user - bootstrap a personal
        // workspace, then re-read context (bypassing the cache) to pick up
        // the new membership.
        await this.authService.ensureBootstrapWorkspace(req.user.id, req.user.name, req.user.email);
        context = await this.authService.resolveRequestContext(req.user.id, wsId, { fresh: true });
      }
    } catch (err) {
      // An org-less staff account is a definite answer, not an outage.
      if (err instanceof ForbiddenException) throw err;
      this.logger.error(`Workspace context resolution failed: ${(err as Error).message}`);
      throw contextUnavailable();
    }
    const sessionContext = context.session;
    this.logger.debug(
      `Resolved session context for user ${req.user.id}: workspaceId=${sessionContext.currentWorkspaceId}`,
    );

    req.workspaceId = sessionContext.currentWorkspaceId;
    req.workspaceMemberships = sessionContext.workspaceMemberships;
    req.projectMemberships = sessionContext.projectMemberships;
    // Effective permissions (company + active workspace), resolved once per
    // request. Every guard, decorator and /auth/me reads these.
    req.permissions = context.permissions;
    // Lets id-only helpers (userHasCompanyPermission, scope resolvers) reuse
    // this instead of re-reading the same rows.
    setRequestAuth({
      userId: req.user.id,
      systemRole: userExtras.systemRole,
      organizationId: userExtras.organizationId,
      permissions: context.permissions,
    });

    return true;
  }

  /** The raw support token of this request, or undefined when it has none. */
  private supportTokenOf(
    ctx: ExecutionContext,
    req: Request & RequestExtensions,
  ): string | string[] | undefined {
    const header = req.headers[SUPPORT_TOKEN_HEADER];
    if (header !== undefined) return header;
    const fromQuery = this.reflector.getAllAndOverride<boolean | undefined>(
      SUPPORT_TOKEN_QUERY_KEY,
      [ctx.getHandler()],
    );
    if (!fromQuery) return undefined;
    const value = (req.query as Record<string, unknown> | undefined)?.[SUPPORT_TOKEN_QUERY_PARAM];
    if (value === undefined) return undefined;
    // A repeated or nested parameter is refused like a repeated header.
    return typeof value === 'string' ? value : [];
  }

  /**
   * A request carrying a support token. Allowed only for a SUPER_ADMIN of the
   * root organization whose token is valid for this user and sign-in session
   * and whose grant is still active (re-read on every request). The request
   * then runs inside the granted organization with read only abilities, every
   * request is recorded in that organization's audit log (refused writes
   * included), and anything but GET/HEAD is refused. Never touches the
   * per-user auth context cache and never bootstraps a workspace.
   */
  private async activateSupportSession(
    ctx: ExecutionContext,
    req: Request & RequestExtensions,
    session: GuardSession,
    rawToken: string | string[],
    requestedWorkspaceId: string | undefined,
  ): Promise<true> {
    // Fail closed: no service, an empty or a repeated header is refused.
    if (!this.supportSessions || typeof rawToken !== 'string' || rawToken.length === 0) {
      throw supportSessionInvalid();
    }

    let context: AuthContext;
    try {
      context = await this.authService.resolveRequestContext(session.user.id);
    } catch (err) {
      this.logger.error(`Auth context resolution failed: ${(err as Error).message}`);
      throw contextUnavailable();
    }
    const extras = context.extras;
    if (extras.userDisabled) throw accountDisabled();
    if (extras.orgInactive) throw organizationSuspended();
    if (
      extras.accountType !== 'STAFF' ||
      extras.systemRole !== 'SUPER_ADMIN' ||
      extras.organizationId !== ROOT_ORG_ID
    ) {
      throw supportNotAllowed();
    }
    const audience = this.reflector.getAllAndOverride<PortalRouteAudience | undefined>(
      PORTAL_ROUTE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (portalBoundary('STAFF', audience) === 'deny-staff') throw clientPortalOnly();

    const support = await this.supportSessions.resolve({
      token: rawToken,
      userId: session.user.id,
      sessionId: session.session.id,
      now: new Date(),
    });

    const method = (req.method ?? '').toUpperCase();
    const path = supportAccessPath(req.originalUrl ?? req.url, req.params);
    const readOnlyRefusal = !isSupportReadMethod(method);
    const excluded = isSupportExcludedPath(
      (req.originalUrl ?? req.url ?? '').split(/[?#]/)[0] ?? '',
      process.env.API_BASE_PATH ?? 'api/v1',
      this.reflector.get<string | string[] | undefined>(PATH_METADATA, ctx.getClass()),
    );
    const refused = readOnlyRefusal || excluded;
    // Logged before the decision, so a refused request is on the record too.
    const accessLogId = await this.supportSessions.recordAccess(support, session.user.id, {
      method,
      path,
      refused,
    });
    // From here on every database write of this request is refused (the
    // backstop in support-write-backstop.ts); the access row above is the
    // one write a support request makes.
    markSupportRequest({ userId: session.user.id, workspaceIds: support.workspaceIds });
    // No request store means the write backstop could not see this request:
    // fail closed rather than serve a support session without it.
    if (!isSupportRequest()) throw supportLogUnavailable();
    if (readOnlyRefusal) throw supportReadOnly();
    if (excluded) throw supportExcluded();
    // A later guard or the service may still refuse it (403): mark the row.
    this.markRefusedOnFinish(ctx, support, accessLogId, method, path);

    const workspaceId =
      requestedWorkspaceId && support.workspaceIds.includes(requestedWorkspaceId)
        ? requestedWorkspaceId
        : (support.workspaceIds[0] ?? null);
    const permissions: EffectivePermissions = {
      company: [...SUPPORT_SESSION_PERMISSIONS.company],
      workspace: workspaceId ? [...SUPPORT_SESSION_PERMISSIONS.workspace] : [],
    };

    // The super admin acts as a plain, read only viewer of the granted
    // organization: no platform role, no admin presets, no project roles.
    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? '',
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
      systemRole: 'EMPLOYEE',
      organizationId: support.organizationId,
      accountType: 'STAFF',
    };
    req.sessionId = session.session.id;
    req.workspaceId = workspaceId;
    req.workspaceMemberships = support.workspaceIds.map((id) => ({
      workspaceId: id,
      role: 'VIEWER',
    }));
    req.projectMemberships = [];
    req.permissions = permissions;
    req.support = {
      grantId: support.grantId,
      organizationId: support.organizationId,
      organizationName: support.organizationName,
      expiresAt: support.expiresAt,
      readOnly: support.readOnly,
    };
    // Kept on the request (never logged) so file links in the response can
    // be rewritten to the guarded content route for this session.
    req.supportToken = rawToken;
    setRequestAuth(
      {
        userId: session.user.id,
        systemRole: 'EMPLOYEE',
        organizationId: support.organizationId,
        permissions,
      },
      { support: { userId: session.user.id, workspaceIds: support.workspaceIds } },
    );
    return true;
  }

  /**
   * When the response of an allowed support request ends with 401 or 403
   * (refused by PermissionsGuard or the service), mark its access row
   * `refused: true`. Best effort: the row already says the request was made.
   */
  private markRefusedOnFinish(
    ctx: ExecutionContext,
    support: { grantId: string; organizationId: string },
    accessLogId: string | null,
    method: string,
    path: string,
  ): void {
    if (!accessLogId || !this.supportSessions) return;
    const http = ctx.switchToHttp();
    const res = (typeof http.getResponse === 'function' ? http.getResponse() : undefined) as
      | { statusCode?: number; once?: (event: string, fn: () => void) => unknown }
      | undefined;
    if (!res || typeof res.once !== 'function') return;
    const sessions = this.supportSessions;
    res.once('finish', () => {
      if (res.statusCode !== 401 && res.statusCode !== 403) return;
      void sessions.markRefused(support, accessLogId, { method, path });
    });
  }
}

type GuardSession = NonNullable<Awaited<ReturnType<AuthService['getSessionFromRequest']>>>;

function accountDisabled(): UnauthorizedException {
  return new UnauthorizedException({
    title: 'Account disabled',
    status: 401,
    detail: 'This account has been disabled. Contact your administrator.',
    code: 'account-disabled',
  });
}

/**
 * Tenant suspension: the user's organization is soft-deleted or inactive.
 */
function organizationSuspended(): UnauthorizedException {
  return new UnauthorizedException({
    title: 'Organization suspended',
    status: 401,
    detail: 'Your organization is archived or suspended. Contact your administrator.',
    code: 'organization-suspended',
  });
}

function portalOnly(): ForbiddenException {
  return new ForbiddenException({
    title: 'Client portal account',
    status: 403,
    detail: 'This account can only use the client portal.',
    code: 'portal-only',
  });
}

function clientPortalOnly(): ForbiddenException {
  return new ForbiddenException({
    title: 'Client portal only',
    status: 403,
    detail: 'This endpoint is for client portal accounts.',
    code: 'client-portal-only',
  });
}

/**
 * A failed context lookup is an outage, not an authentication answer.
 * Returning 401 here made the web client sign the user out.
 */
function contextUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    title: 'Service temporarily unavailable',
    status: 503,
    detail: "Couldn't load your workspace right now. Please try again.",
    code: 'context-unavailable',
  });
}

export interface RequestExtensions {
  user?: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image: string | null;
    // Sourced from the shared Zod enum rather than re-typed by hand, so
    // adding a role can never silently desync this from the DB.
    systemRole: SystemRole;
    organizationId: string | null;
    accountType: AccountType;
  };
  sessionId?: string;
  workspaceId?: string | null;
  workspaceMemberships?: Array<{ workspaceId: string; role: string }>;
  projectMemberships?: Array<{
    projectId: string;
    workspaceId: string;
    role: string;
    abilities: unknown;
  }>;
  /** Effective permissions for the active workspace (set by AuthGuard). */
  permissions?: EffectivePermissions;
  /** Set only while the request runs in a read only support session. */
  support?: SupportSessionInfo;
  /** The raw support token of this request (support sessions only, never logged). */
  supportToken?: string;
}
