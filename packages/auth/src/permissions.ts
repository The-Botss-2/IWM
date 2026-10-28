import type { SystemRole, WorkspaceRole } from '@botss/shared-types';

/**
 * Configurable roles & permissions.
 *
 * The catalog below is the single list of permission keys. Roles (presets in
 * code, custom roles in the `Role` table) are just sets of these keys, and
 * per-person overrides grant or deny single keys on top.
 *
 * Two scopes:
 *  - `company`: org-wide, held via the user's company role (systemRole preset
 *    or `User.customRoleId`) plus company overrides.
 *  - `workspace`: held per workspace membership (WorkspaceRole preset or
 *    `WorkspaceMembership.customRoleId`) plus that workspace's overrides.
 *
 * `sales.leads.all` / `sales.clients.all` exist in BOTH scopes: company-wide
 * from a company role, or for one workspace only from a workspace role.
 *
 * Presets reproduce the behaviour that existed before roles were configurable
 * (see `check-permissions.ts` in apps/api), with one intended change:
 * workspace OWNER / ADMIN now see every lead and client of THAT workspace.
 */

export type PermissionScope = 'company' | 'workspace';

export interface PermissionDef {
  key: string;
  scope: PermissionScope;
  group: string;
  label: string;
  description?: string;
}

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  // ─── Company ───────────────────────────────────────────────────────────
  {
    key: 'finance.view',
    scope: 'company',
    group: 'Finance',
    label: 'View finance',
    description: 'Contracts, payments, expenses and invoices (read only).',
  },
  {
    key: 'finance.manage',
    scope: 'company',
    group: 'Finance',
    label: 'Manage finance',
    description: 'Create and edit contracts, payments, expenses and invoices.',
  },
  {
    key: 'payroll.manage',
    scope: 'company',
    group: 'Finance',
    label: 'Manage payroll',
    description: 'Salaries, payroll runs and payslips.',
  },
  {
    key: 'hr.attendance',
    scope: 'company',
    group: 'HR',
    label: 'Manage attendance',
    description: "View and correct everyone's attendance.",
  },
  {
    key: 'hr.leave.approve',
    scope: 'company',
    group: 'HR',
    label: 'Approve leave',
    description: "Review and decide on everyone's leave requests.",
  },
  {
    key: 'users.manage',
    scope: 'company',
    group: 'People',
    label: 'Manage users',
    description: 'Create, edit and offboard users.',
  },
  {
    key: 'roles.manage',
    scope: 'company',
    group: 'People',
    label: 'Manage roles',
    description: 'Create and edit roles, assign company roles and per-person extras.',
  },
  { key: 'workspaces.create', scope: 'company', group: 'Workspaces', label: 'Create workspaces' },
  {
    key: 'workspaces.admin_all',
    scope: 'company',
    group: 'Workspaces',
    label: 'Administer every workspace',
    description:
      'Full control of every workspace in the company, including ones they have not joined.',
  },
  { key: 'audit.view', scope: 'company', group: 'Administration', label: 'View audit log' },
  {
    key: 'org.settings',
    scope: 'company',
    group: 'Administration',
    label: 'Company settings',
    description: 'Organization details, mail and feature settings.',
  },
  {
    key: 'sales.leads.all',
    scope: 'company',
    group: 'Sales',
    label: 'All leads (company-wide)',
    description: 'See and work every lead in every workspace.',
  },
  {
    key: 'sales.clients.all',
    scope: 'company',
    group: 'Sales',
    label: 'All clients (company-wide)',
    description: 'See and work every client in every workspace.',
  },

  // ─── Workspace ─────────────────────────────────────────────────────────
  {
    key: 'workspace.view',
    scope: 'workspace',
    group: 'Workspace',
    label: 'View workspace content',
    description: 'Projects, tasks and documents.',
  },
  {
    key: 'workspace.view_all',
    scope: 'workspace',
    group: 'Workspace',
    label: 'View everything',
    description: 'Also members, files, project members and signature requests.',
  },
  {
    key: 'workspace.settings',
    scope: 'workspace',
    group: 'Workspace',
    label: 'Workspace settings',
    description: 'Rename the workspace, custom fields.',
  },
  {
    key: 'members.manage',
    scope: 'workspace',
    group: 'Workspace',
    label: 'Manage members',
    description: 'Invite, remove and change roles of workspace members.',
  },
  { key: 'projects.create', scope: 'workspace', group: 'Projects', label: 'Create projects' },
  {
    key: 'projects.update',
    scope: 'workspace',
    group: 'Projects',
    label: 'Edit projects',
    description: 'Project settings, sprints, goals and task forms.',
  },
  { key: 'projects.delete', scope: 'workspace', group: 'Projects', label: 'Delete projects' },
  {
    key: 'tasks.create',
    scope: 'workspace',
    group: 'Projects',
    label: 'Create tasks',
    description: 'Also delete tasks they created.',
  },
  { key: 'tasks.update', scope: 'workspace', group: 'Projects', label: 'Edit tasks' },
  { key: 'tasks.delete_any', scope: 'workspace', group: 'Projects', label: 'Delete any task' },
  {
    key: 'documents.create',
    scope: 'workspace',
    group: 'Documents',
    label: 'Create and edit documents',
    description: 'Also delete documents they created.',
  },
  {
    key: 'documents.manage_all',
    scope: 'workspace',
    group: 'Documents',
    label: 'Manage all documents',
  },
  {
    key: 'files.upload',
    scope: 'workspace',
    group: 'Documents',
    label: 'Upload files',
    description: 'Also delete files they uploaded.',
  },
  { key: 'files.manage_all', scope: 'workspace', group: 'Documents', label: 'Manage all files' },
  { key: 'signatures.send', scope: 'workspace', group: 'Documents', label: 'Request signatures' },
  {
    key: 'sales.leads.all',
    scope: 'workspace',
    group: 'Sales',
    label: 'All leads in this workspace',
  },
  { key: 'sales.leads.create', scope: 'workspace', group: 'Sales', label: 'Create leads' },
  { key: 'sales.leads.delete', scope: 'workspace', group: 'Sales', label: 'Delete leads' },
  {
    key: 'sales.clients.all',
    scope: 'workspace',
    group: 'Sales',
    label: 'All clients in this workspace',
  },
  { key: 'sales.clients.create', scope: 'workspace', group: 'Sales', label: 'Create clients' },
  { key: 'sales.clients.delete', scope: 'workspace', group: 'Sales', label: 'Delete clients' },
  {
    key: 'portal.manage',
    scope: 'workspace',
    group: 'Sales',
    label: 'Manage client portal',
    description: 'Invite client people and manage portal access.',
  },
];

export const COMPANY_PERMISSIONS: readonly string[] = PERMISSION_CATALOG.filter(
  (p) => p.scope === 'company',
).map((p) => p.key);
export const WORKSPACE_PERMISSIONS: readonly string[] = PERMISSION_CATALOG.filter(
  (p) => p.scope === 'workspace',
).map((p) => p.key);

export function isPermissionKey(key: string, scope: PermissionScope): boolean {
  return (scope === 'company' ? COMPANY_PERMISSIONS : WORKSPACE_PERMISSIONS).includes(key);
}

// ─── Presets ─────────────────────────────────────────────────────────────

const SALES_ALL = ['sales.leads.all', 'sales.clients.all'];

export const COMPANY_PRESETS: Record<SystemRole, readonly string[]> = {
  SUPER_ADMIN: COMPANY_PERMISSIONS,
  ADMIN: COMPANY_PERMISSIONS,
  HR: ['hr.attendance', 'hr.leave.approve', ...SALES_ALL],
  FINANCE: ['finance.view', 'finance.manage', 'payroll.manage', ...SALES_ALL],
  PROJECT_MANAGER: [],
  EMPLOYEE: [],
};

/** Presets whose permissions can not be edited at all. */
export const LOCKED_COMPANY_PRESETS: readonly SystemRole[] = ['SUPER_ADMIN', 'ADMIN'];

export type WorkspacePresetKey = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const MEMBER_PRESET = [
  'workspace.view',
  'workspace.view_all',
  'projects.create',
  'projects.update',
  'tasks.create',
  'tasks.update',
  'documents.create',
  'files.upload',
  'signatures.send',
];

export const WORKSPACE_PRESETS: Record<WorkspacePresetKey, readonly string[]> = {
  OWNER: WORKSPACE_PERMISSIONS,
  ADMIN: WORKSPACE_PERMISSIONS,
  MEMBER: MEMBER_PRESET,
  VIEWER: ['workspace.view'],
};

/** Collapse legacy / unused enum values onto the four presets. */
export function workspacePresetFor(role: WorkspaceRole | string): WorkspacePresetKey {
  switch (role) {
    case 'OWNER':
      return 'OWNER';
    case 'ADMIN':
      return 'ADMIN';
    case 'MEMBER':
    case 'MANAGER':
    case 'EDITOR':
      return 'MEMBER';
    default:
      // VIEWER and the legacy CLIENT role (which read the same subjects).
      return 'VIEWER';
  }
}

/**
 * What a read only support session holds inside the organization that
 * granted it: read keys only. Nothing that manages anything, no payroll
 * (salaries and bank details), no mailboxes. The API also refuses every
 * non GET request in a support session, so a key here can never write.
 */
export const SUPPORT_SESSION_PERMISSIONS: Readonly<{
  company: readonly string[];
  workspace: readonly string[];
}> = {
  company: ['audit.view', 'finance.view', 'sales.clients.all', 'sales.leads.all'],
  workspace: ['sales.clients.all', 'sales.leads.all', 'workspace.view', 'workspace.view_all'],
};

// ─── Resolution ──────────────────────────────────────────────────────────

export interface PermissionOverride {
  permission: string;
  grant: boolean;
  /** null / undefined = company override. */
  workspaceId?: string | null;
}

export interface EffectivePermissions {
  company: string[];
  /** Permissions in the ACTIVE workspace only. */
  workspace: string[];
}

function applyOverrides(
  base: readonly string[],
  overrides: readonly PermissionOverride[],
  scope: PermissionScope,
): string[] {
  const set = new Set(base);
  for (const o of overrides) {
    if (!isPermissionKey(o.permission, scope)) continue;
    if (o.grant) set.add(o.permission);
  }
  for (const o of overrides) {
    if (!isPermissionKey(o.permission, scope)) continue;
    if (!o.grant) set.delete(o.permission);
  }
  return [...set].sort();
}

export function resolveCompanyPermissions(input: {
  systemRole?: SystemRole | null | undefined;
  customRolePermissions?: readonly string[] | null | undefined;
  overrides?: readonly PermissionOverride[] | undefined;
}): string[] {
  const sys = input.systemRole ?? 'EMPLOYEE';
  // The platform operator always holds everything; nothing can take it away.
  if (sys === 'SUPER_ADMIN') return [...COMPANY_PERMISSIONS].sort();
  const base = input.customRolePermissions ?? COMPANY_PRESETS[sys];
  const resolved = applyOverrides(
    base,
    (input.overrides ?? []).filter((o) => !o.workspaceId),
    'company',
  );
  // An org ADMIN can never lose roles.manage, so the org can't lock itself out.
  if (sys === 'ADMIN' && !input.customRolePermissions && !resolved.includes('roles.manage')) {
    resolved.push('roles.manage');
    resolved.sort();
  }
  return resolved;
}

export function resolveWorkspacePermissions(input: {
  role?: WorkspaceRole | string | null;
  customRolePermissions?: readonly string[] | null | undefined;
  overrides?: readonly PermissionOverride[] | undefined;
  workspaceId?: string | null;
}): string[] {
  if (!input.role) return [];
  const base = input.customRolePermissions ?? WORKSPACE_PRESETS[workspacePresetFor(input.role)];
  return applyOverrides(
    base,
    (input.overrides ?? []).filter((o) => !!o.workspaceId && o.workspaceId === input.workspaceId),
    'workspace',
  );
}

/**
 * Preset-only resolution, used when a caller has not resolved custom roles and
 * overrides (old call sites, scripts). Reproduces today's behaviour.
 */
export function presetPermissions(ctx: {
  systemRole?: SystemRole | null | undefined;
  workspaceMemberships?: readonly { role: WorkspaceRole | string }[] | undefined;
}): EffectivePermissions {
  const ws = new Set<string>();
  for (const m of ctx.workspaceMemberships ?? []) {
    for (const p of WORKSPACE_PRESETS[workspacePresetFor(m.role)]) ws.add(p);
  }
  return {
    company: resolveCompanyPermissions({ systemRole: ctx.systemRole }),
    workspace: [...ws].sort(),
  };
}

export function hasCompanyPermission(eff: EffectivePermissions, key: string): boolean {
  return eff.company.includes(key);
}

export function hasWorkspacePermission(eff: EffectivePermissions, key: string): boolean {
  return eff.workspace.includes(key);
}

/** Held in either scope (company grant or active-workspace grant). */
export function hasPermission(eff: EffectivePermissions, key: string): boolean {
  return eff.company.includes(key) || eff.workspace.includes(key);
}

/** True when every workspace permission is held: behaves as a workspace OWNER/ADMIN. */
export function isFullWorkspaceAdmin(eff: EffectivePermissions): boolean {
  return WORKSPACE_PERMISSIONS.every((k) => eff.workspace.includes(k));
}

// ─── Guardrails ──────────────────────────────────────────────────────────

/**
 * Whether `actor` may set the given workspace permissions (a custom role's
 * permissions or a per-member override) on someone in their workspace.
 * Company `roles.manage` may set anything; a workspace `members.manage`
 * holder may only hand out workspace permissions they hold themselves.
 */
export function canAssignWorkspacePermissions(
  actor: EffectivePermissions,
  permissions: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  for (const p of permissions) {
    if (!isPermissionKey(p, 'workspace')) {
      return { ok: false, reason: `"${p}" is not a workspace permission.` };
    }
  }
  if (actor.company.includes('roles.manage')) return { ok: true };
  if (!actor.workspace.includes('members.manage')) {
    return { ok: false, reason: 'You can not manage members in this workspace.' };
  }
  const missing = permissions.filter((p) => !actor.workspace.includes(p));
  if (missing.length > 0) {
    return { ok: false, reason: `You can only give permissions you hold: ${missing.join(', ')}.` };
  }
  return { ok: true };
}
