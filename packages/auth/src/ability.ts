import { Ability, AbilityBuilder, type AbilityClass } from '@casl/ability';
import { projectAbilityRuleSchema } from '@botss/shared-types';
import type {
  ProjectAbilityAction,
  ProjectAbilitySubject,
  ProjectRole,
  SystemRole,
  WorkspaceRole,
} from '@botss/shared-types';

import type { AppAbility, AppAction, AppSubject } from './ability.types.js';
import {
  type EffectivePermissions,
  hasPermission,
  isFullWorkspaceAdmin,
  presetPermissions,
} from './permissions.js';

// Re-export the ability types alongside the factory so consumers of the
// `@botss/auth/ability` subpath get everything they need from one import.
export type { AppAbility, AppAction, AppSubject } from './ability.types.js';
export * from './permissions.js';

const AppAbilityClass = Ability as AbilityClass<AppAbility>;

export interface AbilityWorkspaceMembership {
  workspaceId: string;
  role: WorkspaceRole;
}

export interface AbilityProjectMembership {
  projectId: string;
  workspaceId: string;
  role: ProjectRole;
  abilities: unknown;
}

export interface AbilityContext {
  userId: string;
  /// Cross-workspace role attached to User. Drives org-level subjects
  /// (Attendance, Leave) that aren't bounded by a workspace. Defaults
  /// to EMPLOYEE so consumers that don't yet pass it stay safe - the
  /// EMPLOYEE branch only grants self-scoped abilities.
  systemRole?: SystemRole;
  workspaceMemberships: AbilityWorkspaceMembership[];
  projectMemberships: AbilityProjectMembership[];
  /// Resolved effective permissions (company + ACTIVE workspace). When absent
  /// they are derived from the presets of `systemRole` and the memberships.
  permissions?: EffectivePermissions;
}

type PermissionCtx = {
  systemRole?: SystemRole | null | undefined;
  workspaceMemberships?: readonly { role: WorkspaceRole }[] | undefined;
  /** Resolved effective permissions. When absent, presets are derived from
   *  `systemRole` + `workspaceMemberships` (today's behaviour). */
  permissions?: EffectivePermissions | undefined;
};

function effective(ctx: PermissionCtx): EffectivePermissions {
  return ctx.permissions ?? presetPermissions(ctx);
}

/**
 * Whether the actor may see and manage EVERY lead in the active workspace, as
 * opposed to only the ones assigned to them: `sales.leads.all` from the
 * company role (company-wide) or from the active workspace's role.
 *
 * Presets: company ADMIN / SUPER_ADMIN / HR / FINANCE, plus workspace OWNER /
 * ADMIN for their own workspace. Callers pass ONLY the active workspace's
 * membership (or its resolved permissions).
 */
export function hasFullLeadAccess(ctx: PermissionCtx): boolean {
  return hasPermission(effective(ctx), 'sales.leads.all');
}

/** Same as `hasFullLeadAccess`, for clients (`sales.clients.all`). */
export function hasFullClientAccess(ctx: PermissionCtx): boolean {
  return hasPermission(effective(ctx), 'sales.clients.all');
}

/** Full access to BOTH leads and clients. */
export function hasFullSalesAccess(ctx: PermissionCtx): boolean {
  return hasFullLeadAccess(ctx) && hasFullClientAccess(ctx);
}

/**
 * Financial subjects (Contract, Payment, PaymentSource, Expense, Invoice) that
 * the actor may see: company `finance.view` or `finance.manage`. Workspace
 * roles never qualify - money is an organisation-wide concern.
 *
 * Exported so the API's guards and the web's nav gating agree on one
 * definition.
 */
export function hasFinanceAccess(ctx: {
  systemRole?: SystemRole | null;
  permissions?: EffectivePermissions;
}): boolean {
  const eff = effective(ctx);
  return eff.company.includes('finance.view') || eff.company.includes('finance.manage');
}

/**
 * The subjects gated by `hasFinanceAccess`. Kept as one list so the Layer 0
 * grant and the Layer 5 revocation below can never drift apart.
 */
export const FINANCE_SUBJECTS = [
  'Contract',
  'Payment',
  'PaymentSource',
  'Expense',
  'Invoice',
  // Salaries and staff bank details: Admin and Finance only.
  'Payroll',
] as const satisfies readonly AppSubject[];

const FINANCE_SUBJECTS_NO_PAYROLL: AppSubject[] = FINANCE_SUBJECTS.filter(
  (s) => s !== 'Payroll',
);

/** A per-member override after validation and project pinning. */
export interface ScopedProjectAbilityRule {
  action: ProjectAbilityAction[];
  subject: ProjectAbilitySubject;
  conditions: { projectId: string } | { id: string };
  fields?: string[];
  inverted: boolean;
  reason?: string;
}

/**
 * Validate `ProjectMembership.abilities` rule by rule against the allowlist
 * (`projectAbilityRuleSchema`) and pin every surviving rule to `projectId`:
 * `{ projectId }` for Task / Document, `{ id }` for Project. Caller-supplied
 * conditions are discarded, never merged, so an override can neither escape
 * its project nor carry an operator the matcher would choke on. Invalid
 * rules (e.g. `manage all` stored before the allowlist existed) are dropped
 * individually. One entry per subject, since the pinned field differs.
 *
 * Used by the ability factory (Layer 3) and by the API before it stores
 * overrides, so the stored JSON is already in this shape.
 */
export function scopeProjectAbilityRules(
  raw: unknown,
  projectId: string,
): ScopedProjectAbilityRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopedProjectAbilityRule[] = [];
  for (const candidate of raw) {
    const parsed = projectAbilityRuleSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const rule = parsed.data;
    const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
    const subjects = Array.isArray(rule.subject) ? rule.subject : [rule.subject];
    for (const subject of new Set(subjects)) {
      out.push({
        action: [...new Set(actions)],
        subject,
        conditions: subject === 'Project' ? { id: projectId } : { projectId },
        ...(rule.fields ? { fields: rule.fields } : {}),
        inverted: rule.inverted === true,
        ...(rule.reason ? { reason: rule.reason } : {}),
      });
    }
  }
  return out;
}

/**
 * The ability of a read only support session (a platform operator browsing
 * an organization that granted support access): `read` on everything except
 * payroll, and no other action at all. Used instead of `defineAbilityFor`
 * whenever the request runs in a support session, on the API (authoritative,
 * next to the method check in AuthGuard) and in the web (UX hint).
 */
export function defineSupportAbility(): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(AppAbilityClass);
  can('read', 'all');
  cannot('manage', 'Payroll');
  return build({
    detectSubjectType: (item: { __type?: AppSubject }) =>
      (item?.__type ?? 'all') as AppSubject,
  });
}

/**
 * Build a CASL ability for the given session context.
 *
 * Layer 1 - Workspace membership grants the broad shape of what the user can
 *           do across the workspace. Callers pass ONLY the active workspace's
 *           membership (see `hasFullSalesAccess`).
 * Layer 2 - Project memberships tighten or extend rights on a per-project basis.
 * Layer 3 - Each ProjectMembership.abilities JSON column may carry per-user
 *           CASL rule overrides; we parse them through Zod and apply them last.
 *
 * NOTE: Phase 1 deliberately uses `manage 'all'` for workspace OWNER/ADMIN -
 * tightening to per-workspace conditions lands in Phase 2 along with granular RBAC.
 */
export function defineAbilityFor(ctx: AbilityContext): AppAbility {
  const builder = new AbilityBuilder<AppAbility>(AppAbilityClass);
  const { can, cannot, build } = builder;

  // CASL's strict TS overloads choke on dynamic conditions; widen to any
  // since the rule shape is built from runtime data anyway.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec = can as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enc = cannot as any;

  const eff = effective(ctx);
  const co = (k: string) => eff.company.includes(k);
  const wsp = (k: string) => eff.workspace.includes(k);

  // ─── Layer 0: company permissions (cross-workspace) ──────────────────────
  // Drives org-level subjects (Attendance, Leave, money) that don't belong to
  // any single workspace. Workspace / project layers below still apply.
  if (co('workspaces.admin_all')) {
    // The org admin administers every workspace in their organization,
    // including ones they never joined. The tenant wall is enforced in the
    // services (isOrgAdminFor, org clamps).
    ec('manage', 'all');
  }
  if (co('hr.attendance')) ec('manage', 'Attendance');
  if (co('hr.leave.approve')) ec('manage', 'Leave');
  if (co('finance.manage')) {
    ec('manage', FINANCE_SUBJECTS_NO_PAYROLL);
  } else if (co('finance.view')) {
    ec('read', FINANCE_SUBJECTS_NO_PAYROLL);
  }
  if (co('payroll.manage')) ec('manage', 'Payroll');
  if (co('finance.view') || co('finance.manage') || co('payroll.manage')) {
    // Read access to the entities money hangs off, so the contract / expense
    // pickers can resolve names.
    ec('read', ['Client', 'Project', 'Workspace', 'User']);
  }
  if (co('workspaces.create')) ec('create', 'Workspace');
  // Everyone sees their own attendance and may request / read their own
  // leave. Status mutations need the HR permissions above.
  ec('read', 'Attendance', { userId: ctx.userId });
  ec('create', 'Leave', { userId: ctx.userId });
  ec('read', 'Leave', { userId: ctx.userId });

  // ─── Layer 1: workspace permissions (active workspace) ───────────────────
  if (isFullWorkspaceAdmin(eff)) {
    // Every workspace permission held: OWNER / ADMIN preset, unchanged.
    ec('manage', 'all');
  } else {
    if (wsp('workspace.view_all')) {
      ec('read', 'all');
    } else if (wsp('workspace.view')) {
      ec('read', ['Workspace', 'Project', 'Task', 'Document', 'Lead', 'Client']);
    }
    if (wsp('workspace.settings')) ec('update', 'Workspace');
    if (wsp('members.manage')) {
      ec('manage', ['WorkspaceMembership', 'ProjectMembership']);
    }
    if (wsp('projects.create')) ec('create', 'Project');
    // `Project` update covers project settings, sprints, goals and task forms.
    if (wsp('projects.update')) ec('update', 'Project');
    if (wsp('projects.delete')) ec('delete', 'Project');
    if (wsp('tasks.create')) {
      ec('create', 'Task');
      ec('delete', 'Task', { createdById: ctx.userId });
    }
    if (wsp('tasks.update')) ec('update', 'Task');
    if (wsp('tasks.delete_any')) ec('delete', 'Task');
    if (wsp('documents.create')) {
      ec(['create', 'update'], 'Document');
      ec('delete', 'Document', { createdById: ctx.userId });
    }
    if (wsp('documents.manage_all')) ec('manage', 'Document');
    if (wsp('files.upload')) {
      ec('create', 'FileObject');
      ec('delete', 'FileObject', { uploadedById: ctx.userId });
    }
    if (wsp('files.manage_all')) ec('manage', 'FileObject');
    // E-signature: SignaturesService re-checks document access and limits
    // send/cancel/resend to the creator or a workspace admin.
    if (wsp('signatures.send')) ec(['create', 'update'], 'SignatureRequest');
    if (wsp('sales.leads.all') || co('sales.leads.all')) {
      ec(['create', 'read', 'update'], 'Lead');
    }
    if (wsp('sales.clients.all') || co('sales.clients.all')) {
      ec(['create', 'read', 'update'], 'Client');
    }
    if (wsp('sales.leads.create')) ec('create', 'Lead');
    if (wsp('sales.leads.delete')) ec('delete', 'Lead');
    if (wsp('sales.clients.create')) ec('create', 'Client');
    if (wsp('sales.clients.delete')) ec('delete', 'Client');
  }

  // Creating a workspace is a company permission (`workspaces.create`). The
  // workspace `manage all` above must not imply it.
  if (!co('workspaces.create')) enc('create', 'Workspace');

  // ─── Layer 2: project-level ──────────────────────────────────────────────
  for (const pm of ctx.projectMemberships) {
    const projectScope = { projectId: pm.projectId };
    if (pm.role === 'PROJECT_LEAD') {
      ec('manage', 'Project', { id: pm.projectId });
      ec('manage', 'Task', projectScope);
      ec('manage', 'ProjectMembership', projectScope);
      ec('manage', 'Document', projectScope);
    } else if (pm.role === 'CONTRIBUTOR') {
      ec('read', 'Project', { id: pm.projectId });
      ec('create', 'Task', projectScope);
      ec('update', 'Task', projectScope);
      ec('read', 'Document', projectScope);
      ec('create', 'Document', projectScope);
    } else if (pm.role === 'REVIEWER') {
      ec('read', 'Project', { id: pm.projectId });
      ec('read', 'Task', projectScope);
      ec('update', 'Task', { projectId: pm.projectId, status: 'IN_REVIEW' });
      ec('read', 'Document', projectScope);
    } else if (pm.role === 'VIEWER') {
      ec('read', 'Project', { id: pm.projectId });
      ec('read', 'Task', projectScope);
      ec('read', 'Document', projectScope);
    }

    // ─── Layer 3: per-user CASL overrides on the membership ──────────────
    // Only allowlisted project subjects/actions, always pinned to THIS
    // membership's project - whatever the stored JSON says.
    for (const rule of scopeProjectAbilityRules(pm.abilities, pm.projectId)) {
      if (rule.inverted) enc(rule.action, rule.subject, rule.conditions);
      else ec(rule.action, rule.subject, rule.conditions);
    }
  }

  // ─── Layer 4: CRM subjects (Lead / Client) ────────────────────────────────
  // Full sales access - a sales systemRole (ADMIN/SUPER_ADMIN/HR) or workspace
  // OWNER/ADMIN - keeps the broad grants from the layers above: every lead and
  // client in the workspace, including create and delete.
  //
  // Everyone else drops to assignee-scoped access. We revoke `manage` first,
  // then hand back plain `read` and `update`, because CASL evaluates rules in
  // order and the LAST matching rule wins. `create` and `delete` stay revoked:
  // a record has to be assigned to a non-admin before they can touch it, so
  // letting them mint one they'd immediately lose sight of makes no sense.
  //
  // The subject-level `read`/`update` here is deliberately unconditional -
  // PermissionsGuard checks abilities against a bare subject name and never
  // sees a record, so row-level narrowing to `assigneeId = me` is enforced in
  // LeadsService / ClientsService via `SalesActor`, not here.
  // Create / delete come back only from the explicit workspace permissions.
  if (!hasPermission(eff, 'sales.leads.all')) {
    enc('manage', 'Lead');
    ec(['read', 'update'], 'Lead');
    if (wsp('sales.leads.create')) ec('create', 'Lead');
    if (wsp('sales.leads.delete')) ec('delete', 'Lead');
  }
  if (!hasPermission(eff, 'sales.clients.all')) {
    enc('manage', 'Client');
    ec(['read', 'update'], 'Client');
    if (wsp('sales.clients.create')) ec('create', 'Client');
    if (wsp('sales.clients.delete')) ec('delete', 'Client');
  }

  // ─── Layer 5: financial subjects ─────────────────────────────────────────
  // LOAD-BEARING. This must stay LAST, because CASL evaluates rules in order
  // and the last matching rule wins.
  //
  // Layer 1 grants `read all` to every workspace MEMBER and `manage all` to
  // every workspace OWNER / ADMIN. Without this revocation, the moment the
  // finance subjects exist every employee in the company can read every
  // contract and every payment, and PermissionsGuard waves them through -
  // the guard checks abilities against a bare subject name and has no other
  // gate to fall back on.
  //
  // `cannot('manage', X)` revokes EVERY action on X, `read` included. Nothing
  // is handed back afterwards: unlike the CRM layer above there is no
  // assignee-scoped middle ground for money.
  if (!co('finance.view') && !co('finance.manage')) {
    enc('manage', FINANCE_SUBJECTS_NO_PAYROLL);
  } else if (!co('finance.manage')) {
    // View-only finance: everything but read is revoked.
    enc(['create', 'update', 'delete'], FINANCE_SUBJECTS_NO_PAYROLL);
  }
  if (!co('payroll.manage')) {
    enc('manage', 'Payroll');
  }

  return build({
    detectSubjectType: (item: { __type?: AppSubject }) =>
      (item?.__type ?? 'all') as AppSubject,
  });
}
