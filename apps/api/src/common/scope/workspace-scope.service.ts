import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { requestAuthFor } from '../request-context';

export interface ResolvedWorkspaceScope {
  /** The workspace ids the caller may read against in this request. */
  workspaceIds: string[];
  /** Mirrors `?workspaceId=...` from the request, after validation. */
  filteredWorkspaceId: string | null;
  /** Organization the caller belongs to. */
  organizationId: string;
}

/**
 * Org-layer scope resolver used by all the cross-workspace-listing
 * services (Tasks, Timesheets, Todos, Email). The contract:
 *
 *   - If `requestedWorkspaceId` is provided AND it belongs to the
 *     caller's organization, the scope is exactly that one workspace.
 *   - If `requestedWorkspaceId` is provided but does NOT belong, throw
 *     a NotFoundException - we never confirm or deny the existence of
 *     out-of-org rows.
 *   - If no `requestedWorkspaceId`, the scope is every workspace in
 *     the caller's organization (the "All workspaces" default).
 *
 * Callers should use the returned `workspaceIds` as the input to a
 * `where: { workspaceId: { in: ... } }` filter rather than re-deriving
 * the boundary themselves.
 */
@Injectable()
export class WorkspaceScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    userId: string,
    requestedWorkspaceId?: string | null,
  ): Promise<ResolvedWorkspaceScope> {
    // AuthGuard already read the caller's org for this request.
    const resolved = requestAuthFor(userId);
    const organizationId = resolved
      ? resolved.organizationId
      : ((
          await this.prisma.client.user.findUnique({
            where: { id: userId },
            select: { organizationId: true },
          })
        )?.organizationId ?? null);
    if (!organizationId) {
      // No org assignment means the caller can only see their own
      // workspace memberships - keep the legacy behavior so we don't
      // accidentally widen visibility for an unmigrated user.
      const memberships =
        await this.prisma.client.workspaceMembership.findMany({
          where: { userId },
          select: { workspaceId: true },
        });
      const scoped = memberships.map((m) => m.workspaceId);
      if (requestedWorkspaceId && !scoped.includes(requestedWorkspaceId)) {
        throw new NotFoundException({
          title: 'Workspace not found',
          status: 404,
        });
      }
      return {
        workspaceIds: requestedWorkspaceId ? [requestedWorkspaceId] : scoped,
        filteredWorkspaceId: requestedWorkspaceId ?? null,
        organizationId: '',
      };
    }

    // Every active workspace inside the user's organization. The caller
    // doesn't need to be a member of every workspace at the DB level -
    // org-wide visibility is the new default; per-workspace access
    // control is enforced at write time, not read time.
    const orgWorkspaces = await this.prisma.client.workspace.findMany({
      where: { organizationId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    const allowed = new Set(orgWorkspaces.map((w) => w.id));

    if (requestedWorkspaceId) {
      if (!allowed.has(requestedWorkspaceId)) {
        // Do NOT leak the existence of out-of-org workspaces - 404, not 403.
        throw new NotFoundException({
          title: 'Workspace not found',
          status: 404,
        });
      }
      return {
        workspaceIds: [requestedWorkspaceId],
        filteredWorkspaceId: requestedWorkspaceId,
        organizationId,
      };
    }

    return {
      workspaceIds: Array.from(allowed),
      filteredWorkspaceId: null,
      organizationId,
    };
  }
}
