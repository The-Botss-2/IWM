import type { UserScope } from './decorators/user-scope.decorator';

/**
 * Project read-visibility, in one place.
 *
 * Two independent gates decide whether a caller may read a project:
 *
 *  1. **Reachability** - the project lives in a workspace they belong to, OR
 *     they hold an explicit ProjectMembership on it (the outside-collaborator
 *     path, where `scope.workspaceIds` is empty).
 *
 *  2. **Visibility** - `Project.visibility`. `WORKSPACE` / `PUBLIC` projects
 *     are readable by anyone who clears gate 1. `PRIVATE` projects are
 *     readable only by their own members, their creator, and the roles listed
 *     in `scope.seesEveryProject` (system admins, workspace owners/admins).
 *
 * Gate 2 used to not exist: `Project.visibility` was written by the settings
 * dropdown and then never consulted, so every workspace member could read
 * every project. Every service that reads projects - or anything hanging off
 * a project - must compose BOTH gates, which is why this lives here instead
 * of being copy-pasted per service.
 */

/**
 * Where-fragment matching every project the caller may read. Spread it into a
 * `project.findMany` where-clause, or nest it under a relation
 * (`{ project: projectAccessWhere(scope) }`) for project-derived rows.
 */
export function projectAccessWhere(scope: UserScope): Record<string, unknown> {
  const ors: Record<string, unknown>[] = [];
  if (scope.workspaceIds.length > 0) {
    ors.push({ workspaceId: { in: scope.workspaceIds } });
  }
  if (scope.projectIds.length > 0) {
    ors.push({ id: { in: scope.projectIds } });
  }
  // Neither path applies. Match nothing - and do it on a NON-id field so this
  // doesn't collide with a caller-supplied `{ id }` constraint when spread.
  if (ors.length === 0) return { workspaceId: '__none__' };

  const reachable = ors.length === 1 ? ors[0]! : { OR: ors };
  const visible = projectVisibilityWhere(scope);
  if (!visible) return reachable;
  return { AND: [reachable, visible] };
}

/**
 * The visibility gate on its own, for callers that already pin the workspace
 * themselves (global search) and only need the PRIVATE filter layered on top.
 *
 * Returns `null` when the caller sees everything, so callers can skip adding
 * a clause entirely rather than composing an always-true one.
 */
export function projectVisibilityWhere(scope: UserScope): Record<string, unknown> | null {
  if (scope.seesEveryProject) return null;
  return {
    OR: [
      { visibility: { not: 'PRIVATE' } },
      // Explicit membership. `in: []` matches nothing in Prisma, which is the
      // correct answer for a caller with no project memberships.
      { id: { in: scope.projectIds } },
      // The creator never loses sight of their own project - otherwise
      // marking one private without adding yourself as a member would hide it
      // from you the moment you saved.
      { createdById: scope.userId },
    ],
  };
}

/**
 * In-memory form of `projectVisibilityWhere` for one already-loaded project:
 * may this caller see it (its name, its link)? Lets list endpoints gate
 * PRIVATE project names without a query per row.
 */
export function canSeeProject(
  scope: Pick<UserScope, 'userId' | 'projectIds' | 'seesEveryProject'>,
  project: { id: string; visibility: string; createdById: string },
): boolean {
  if (scope.seesEveryProject) return true;
  if (project.visibility !== 'PRIVATE') return true;
  return scope.projectIds.includes(project.id) || project.createdById === scope.userId;
}
