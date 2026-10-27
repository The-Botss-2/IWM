import {
  type AppAbility,
  type AppSubject,
  defineAbilityFor,
  defineSupportAbility,
} from '@botss/auth';
import type { ProjectRole, WorkspaceRole } from '@botss/shared-types';

import type { RequestExtensions } from '../guards/auth.guard';
import { requestPermissions } from './effective-permissions';

const cache = new WeakMap<object, AppAbility>();

/**
 * The CASL ability of the request's user in the ACTIVE workspace. One
 * definition shared by PermissionsGuard and by services that must check a
 * concrete row (see `abilityRow`), cached per request.
 *
 * Only the active workspace counts. AuthGuard loads every membership the user
 * holds in their org, and Layer 1 of the ability factory grants `manage all`
 * to any OWNER/ADMIN membership. Feeding all of them in meant a VIEWER in
 * workspace B who owns a personal workspace passed every `@RequireAbility`
 * check in B. Mirrors the narrowing in RequestUserScope.
 */
export function abilityForRequest(req: RequestExtensions): AppAbility {
  const hit = cache.get(req);
  if (hit) return hit;
  if (!req.user) throw new Error('abilityForRequest called without an authenticated user');
  // A read only support session never builds a role-based ability: `read`
  // only (no payroll), whatever the permissions say.
  if (req.support) {
    const support = defineSupportAbility();
    cache.set(req, support);
    return support;
  }
  const activeWorkspaceId = req.workspaceId ?? null;
  const ability = defineAbilityFor({
    userId: req.user.id,
    // Threaded through so the ability factory can apply the Lead/Client
    // systemRole gate. Without this the inverted rule in the factory never
    // fires server-side and the gate is silently disabled.
    systemRole: req.user.systemRole,
    // Effective permissions (custom roles + overrides) for the active
    // workspace, resolved once by AuthGuard. Layers 0/1/4/5 read these.
    permissions: requestPermissions(req),
    workspaceMemberships: (req.workspaceMemberships ?? [])
      .filter((m) => activeWorkspaceId !== null && m.workspaceId === activeWorkspaceId)
      .map((m) => ({ workspaceId: m.workspaceId, role: m.role as WorkspaceRole })),
    projectMemberships: (req.projectMemberships ?? [])
      .filter((m) => activeWorkspaceId !== null && m.workspaceId === activeWorkspaceId)
      .map((m) => ({
        projectId: m.projectId,
        workspaceId: m.workspaceId,
        role: m.role as ProjectRole,
        abilities: m.abilities,
      })),
  });
  cache.set(req, ability);
  return ability;
}

/**
 * Wrap a loaded row so CASL evaluates conditional rules against it. The
 * factory's `detectSubjectType` reads `__type`.
 *
 * PermissionsGuard checks the bare subject name, which CASL answers "yes"
 * for as soon as ANY rule - conditional or not - could allow the action
 * (`delete Task { createdById: me }` lets every `delete Task` request
 * through). Services that act on one row must re-check with the row:
 *
 *   if (!ability.can('delete', abilityRow('Task', task))) throw ...
 */
export function abilityRow<T extends object>(type: AppSubject, row: T): AppSubject {
  // CASL's typed `can()` only accepts subject names; an instance tagged with
  // `__type` is what the factory's detectSubjectType resolves at runtime.
  return { ...row, __type: type } as unknown as AppSubject;
}
