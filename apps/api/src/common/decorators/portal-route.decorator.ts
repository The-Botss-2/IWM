import { applyDecorators, SetMetadata } from '@nestjs/common';

import { SKIP_PERMISSIONS_KEY } from './skip-permissions.decorator';

export const PORTAL_ROUTE_KEY = 'portalRoute';

/**
 * - `client-only`: only CLIENT (portal) accounts. Staff get 403.
 * - `both`: staff and client accounts, e.g. `/auth/me`, which tells the web
 *   app which of the two it is talking to.
 */
export type PortalRouteAudience = 'client-only' | 'both';

/**
 * Opens a route to CLIENT accounts. AuthGuard refuses a CLIENT account on
 * every route WITHOUT this decorator, so a new internal endpoint is closed to
 * clients by default and only an explicit `@PortalRoute()` opens one.
 *
 * Also skips PermissionsGuard: portal authorization is the portal scope
 * helper (`portal/portal-scope.ts`), never CASL. A handler behind this
 * decorator must not use `@CurrentOrganizationId`, `@CurrentWorkspaceId`,
 * `@CurrentSalesActor` or `RequestUserScope` - a CLIENT account has no org
 * and no workspace.
 */
export const PortalRoute = (audience: PortalRouteAudience = 'client-only') =>
  applyDecorators(
    SetMetadata(PORTAL_ROUTE_KEY, audience),
    SetMetadata(SKIP_PERMISSIONS_KEY, true),
  );

/**
 * The boundary decision AuthGuard applies, kept pure so it can be checked
 * without a request:
 * - `client`: a CLIENT account on a portal route - no workspace context.
 * - `staff`: a STAFF account on an internal or shared route - resolve the
 *   workspace context as usual.
 * - `deny-client`: a CLIENT account on an internal route.
 * - `deny-staff`: a STAFF account on a client-only portal route.
 */
export function portalBoundary(
  accountType: 'STAFF' | 'CLIENT',
  audience: PortalRouteAudience | undefined,
): 'client' | 'staff' | 'deny-client' | 'deny-staff' {
  if (accountType === 'CLIENT') return audience ? 'client' : 'deny-client';
  return audience === 'client-only' ? 'deny-staff' : 'staff';
}
