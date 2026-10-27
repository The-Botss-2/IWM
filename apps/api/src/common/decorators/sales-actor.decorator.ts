import { createParamDecorator, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { hasFinanceAccess, hasPermission } from '@botss/auth';

import type { RequestExtensions } from '../guards/auth.guard';
import { requestPermissions } from '../permissions/effective-permissions';

/**
 * Who is acting on Leads / Clients, and how much of the pipeline they may see.
 *
 * Leads and clients are visible two ways:
 *   1. Full sales access - a sales systemRole (ADMIN / SUPER_ADMIN / HR) or
 *      OWNER / ADMIN on the *active* workspace. Sees every record in it.
 *   2. Assignment - anyone else sees only records where `assigneeId` is them.
 *
 * `PermissionsGuard` can only answer "may this user touch Leads at all?"
 * because CASL is checked against a bare subject name with no record in hand.
 * This decorator carries the missing half: the services use `fullAccess` to
 * decide between an unrestricted query and one pinned to `assigneeId = userId`.
 */
export interface SalesActor {
  userId: string;
  /** The active workspace, resolved by AuthGuard from `x-workspace-id`. */
  workspaceId: string;
  /** True when every lead AND client in the workspace is visible. */
  fullAccess: boolean;
  /** `sales.leads.all` (company-wide or for this workspace). */
  fullLeads: boolean;
  /** `sales.clients.all` (company-wide or for this workspace). */
  fullClients: boolean;
  /**
   * Org finance roles (ADMIN / SUPER_ADMIN / FINANCE). They may READ every
   * client in the workspace (billing is per client), but this never widens
   * writes - see `clients/client-visibility.ts`.
   */
  financeAccess: boolean;
}

export const CurrentSalesActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SalesActor => {
    const req = ctx.switchToHttp().getRequest<RequestExtensions>();
    if (!req.user) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'No authenticated user on request.',
      });
    }
    if (!req.workspaceId) {
      throw new ForbiddenException({
        title: 'No active workspace',
        status: 403,
        detail: 'The current user has no workspace membership and cannot access this resource.',
      });
    }
    const workspaceId = req.workspaceId;

    // Permissions are already narrowed to the ACTIVE workspace by AuthGuard.
    // Being an ADMIN of some other workspace must not unlock this one.
    const eff = requestPermissions(req);
    const fullLeads = hasPermission(eff, 'sales.leads.all');
    const fullClients = hasPermission(eff, 'sales.clients.all');
    return {
      userId: req.user.id,
      workspaceId,
      fullAccess: fullLeads && fullClients,
      fullLeads,
      fullClients,
      financeAccess: hasFinanceAccess({ permissions: eff }),
    };
  },
);
