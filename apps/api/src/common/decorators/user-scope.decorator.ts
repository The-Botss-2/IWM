import { createParamDecorator, type ExecutionContext, ForbiddenException } from '@nestjs/common';

import { isFullWorkspaceAdmin } from '@botss/auth';

import type { RequestExtensions } from '../guards/auth.guard';
import { requestPermissions } from '../permissions/effective-permissions';

/**
 * Per-request access scope, **constrained to the currently active workspace**.
 *
 * The AuthGuard reads the `x-workspace-id` request header and sets
 * `req.workspaceId` to the selected tenant. This decorator then narrows the
 * user's full membership list to just that workspace plus any project
 * memberships inside it, so service-layer query filters can't accidentally
 * pull data from other tenants the user happens to belong to.
 *
 * Project endpoints support two paths:
 *   1. The user is a workspace member → they can see every project in that workspace.
 *   2. The user is a project member but NOT a workspace member (e.g. an outside
 *      collaborator) → they can only see the specific projects they are a member of.
 *
 * Services OR `workspaceId IN workspaceIds` with `id IN projectIds`. After this
 * decorator's filtering, both arrays only reference the current workspace.
 */
export interface UserScope {
  userId: string;
  /** Always either `[currentWorkspaceId]` (member) or `[]` (outside collaborator). */
  workspaceIds: string[];
  /** Project memberships scoped to the current workspace only. */
  projectIds: string[];
  /** The active workspace id resolved from the `x-workspace-id` header. */
  currentWorkspaceId: string | null;
  /** The caller's role in the ACTIVE workspace, or null if not a member. */
  workspaceRole: string | null;
  /**
   * True when the caller bypasses `Project.visibility` and reads every project
   * in the workspace, private ones included: org admins (SystemRole ADMIN /
   * SUPER_ADMIN) plus the workspace's own OWNER and ADMIN members.
   *
   * Consumed by `projectAccessWhere` in ../project-access. Resolved here, once
   * per request, so no service has to re-derive it - and so "who is an admin"
   * has exactly one definition.
   */
  seesEveryProject: boolean;
}

export const RequestUserScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserScope => {
    const req = ctx.switchToHttp().getRequest<RequestExtensions>();
    if (!req.user) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'No authenticated user on request.',
      });
    }
    const currentWorkspaceId = req.workspaceId ?? null;

    // Workspace memberships are filtered to the currently active workspace so a
    // user belonging to multiple tenants never sees data from the others. If
    // the user is not a member of the active workspace (e.g. they're an
    // outside collaborator with only project access), workspaceIds is empty.
    const workspaceIds = (req.workspaceMemberships ?? [])
      .filter((m) => currentWorkspaceId != null && m.workspaceId === currentWorkspaceId)
      .map((m) => m.workspaceId);

    // Project memberships are filtered the same way - only projects that live
    // inside the active workspace count. Outside-collaborator access to a
    // project in a *different* workspace requires switching workspaces first.
    const projectIds = (req.projectMemberships ?? [])
      .filter((m) => currentWorkspaceId != null && m.workspaceId === currentWorkspaceId)
      .map((m) => m.projectId);

    // Role in the ACTIVE workspace only. A user who owns workspace A but is a
    // plain member of workspace B must not carry A's privileges into B.
    const workspaceRole =
      (req.workspaceMemberships ?? []).find(
        (m) => currentWorkspaceId != null && m.workspaceId === currentWorkspaceId,
      )?.role ?? null;

    // Org admins (company `workspaces.admin_all`) plus full workspace admins
    // (every workspace permission: the OWNER / ADMIN presets).
    const eff = requestPermissions(req);
    const seesEveryProject =
      eff.company.includes('workspaces.admin_all') ||
      (workspaceRole !== null && isFullWorkspaceAdmin(eff));

    return {
      userId: req.user.id,
      workspaceIds,
      projectIds,
      currentWorkspaceId,
      workspaceRole,
      seesEveryProject,
    };
  },
);
