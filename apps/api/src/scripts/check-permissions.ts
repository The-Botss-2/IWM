/**
 * Pure checks for configurable roles & permissions: preset resolution keeps
 * today's behaviour, custom roles / overrides resolve as documented, and the
 * workspace-manager guardrail holds. No database.
 *
 *   pnpm --filter @botss/api exec tsx src/scripts/check-permissions.ts
 */
import assert from 'node:assert/strict';

import {
  canAssignWorkspacePermissions,
  defineAbilityFor,
  hasFinanceAccess,
  hasFullClientAccess,
  hasFullLeadAccess,
  hasFullSalesAccess,
  isFullWorkspaceAdmin,
  presetPermissions,
  resolveCompanyPermissions,
  resolveWorkspacePermissions,
  type EffectivePermissions,
} from '@botss/auth';
import type { SystemRole, WorkspaceRole } from '@botss/shared-types';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const ability = (systemRole: SystemRole, role: WorkspaceRole | null, permissions?: EffectivePermissions) =>
  defineAbilityFor({
    userId: 'u1',
    systemRole,
    workspaceMemberships: role ? [{ workspaceId: 'w1', role }] : [],
    projectMemberships: [],
    ...(permissions ? { permissions } : {}),
  });

// ─── Presets reproduce today's behaviour ──────────────────────────────────

check('SUPER_ADMIN and ADMIN manage everything', () => {
  for (const s of ['SUPER_ADMIN', 'ADMIN'] as const) {
    const a = ability(s, 'MEMBER');
    assert.ok(a.can('manage', 'all'), s);
    assert.ok(a.can('delete', 'Lead'), s);
    assert.ok(a.can('manage', 'Payroll'), s);
    assert.ok(a.can('create', 'Workspace'), s);
  }
});

check('FINANCE: money yes, payroll yes, attendance no', () => {
  const a = ability('FINANCE', 'MEMBER');
  assert.ok(a.can('manage', 'Contract'));
  assert.ok(a.can('manage', 'Payroll'));
  assert.ok(a.can('read', 'Client'));
  assert.ok(!a.can('manage', 'Attendance'));
  assert.ok(hasFinanceAccess({ systemRole: 'FINANCE' }));
});

check('HR: attendance + leave, no money', () => {
  const a = ability('HR', 'MEMBER');
  assert.ok(a.can('manage', 'Attendance'));
  assert.ok(a.can('manage', 'Leave'));
  assert.ok(!a.can('read', 'Contract'));
  assert.ok(!a.can('read', 'Payroll'));
  assert.ok(!hasFinanceAccess({ systemRole: 'HR' }));
});

check('EMPLOYEE MEMBER: no money, assignee-scoped sales, no create Workspace', () => {
  const a = ability('EMPLOYEE', 'MEMBER');
  assert.ok(!a.can('read', 'Contract'));
  assert.ok(!a.can('read', 'Payroll'));
  assert.ok(a.can('read', 'Lead'));
  assert.ok(a.can('update', 'Client'));
  assert.ok(!a.can('create', 'Lead'));
  assert.ok(!a.can('delete', 'Client'));
  assert.ok(a.can('create', 'Project'));
  assert.ok(a.can('update', 'Project'));
  assert.ok(!a.can('delete', 'Project'));
  assert.ok(a.can('create', 'Task'));
  assert.ok(a.can('read', 'WorkspaceMembership'));
  assert.ok(!a.can('update', 'WorkspaceMembership'));
  assert.ok(a.can('create', 'SignatureRequest'));
  assert.ok(!a.can('create', 'Workspace'), 'MEMBER lost create Workspace');
  assert.ok(!hasFullSalesAccess({ systemRole: 'EMPLOYEE', workspaceMemberships: [{ role: 'MEMBER' }] }));
});

check('EMPLOYEE VIEWER: read only', () => {
  const a = ability('EMPLOYEE', 'VIEWER');
  assert.ok(a.can('read', 'Project'));
  assert.ok(!a.can('create', 'Task'));
  assert.ok(!a.can('read', 'FileObject'));
});

check('Workspace OWNER/ADMIN: manage workspace + (new) all sales there, still no money', () => {
  for (const r of ['OWNER', 'ADMIN'] as const) {
    const a = ability('EMPLOYEE', r);
    assert.ok(a.can('manage', 'Project'), r);
    assert.ok(a.can('delete', 'Lead'), r);
    assert.ok(a.can('create', 'Client'), r);
    assert.ok(!a.can('read', 'Contract'), r);
    assert.ok(!a.can('read', 'Payroll'), r);
    assert.ok(!a.can('create', 'Workspace'), r);
    assert.ok(hasFullLeadAccess({ systemRole: 'EMPLOYEE', workspaceMemberships: [{ role: r }] }), r);
  }
});

check('no membership: nothing in the workspace', () => {
  const a = ability('EMPLOYEE', null);
  assert.ok(!a.can('read', 'Project'));
  assert.ok(a.can('read', 'Attendance'));
});

check('MANAGER/EDITOR map to MEMBER, CLIENT to VIEWER', () => {
  assert.deepEqual(resolveWorkspacePermissions({ role: 'MANAGER' }), resolveWorkspacePermissions({ role: 'MEMBER' }));
  assert.deepEqual(resolveWorkspacePermissions({ role: 'EDITOR' }), resolveWorkspacePermissions({ role: 'MEMBER' }));
  assert.deepEqual(resolveWorkspacePermissions({ role: 'CLIENT' }), resolveWorkspacePermissions({ role: 'VIEWER' }));
});

check('presetPermissions equals explicit resolution', () => {
  const p = presetPermissions({ systemRole: 'HR', workspaceMemberships: [{ role: 'OWNER' }] });
  assert.deepEqual(p.company, resolveCompanyPermissions({ systemRole: 'HR' }));
  assert.ok(isFullWorkspaceAdmin(p));
});

// ─── Custom roles and overrides ───────────────────────────────────────────

check('custom company role replaces the preset', () => {
  const company = resolveCompanyPermissions({ systemRole: 'EMPLOYEE', customRolePermissions: ['finance.view'] });
  assert.deepEqual(company, ['finance.view']);
  const a = ability('EMPLOYEE', 'MEMBER', { company, workspace: resolveWorkspacePermissions({ role: 'MEMBER' }) });
  assert.ok(a.can('read', 'Contract'));
  assert.ok(!a.can('create', 'Contract'), 'view-only finance');
  assert.ok(!a.can('read', 'Payroll'));
});

check('SUPER_ADMIN is always everything, overrides ignored', () => {
  const c = resolveCompanyPermissions({
    systemRole: 'SUPER_ADMIN',
    customRolePermissions: [],
    overrides: [{ permission: 'roles.manage', grant: false }],
  });
  assert.ok(c.includes('roles.manage'));
  assert.ok(c.includes('finance.manage'));
});

check('ADMIN preset can not lose roles.manage', () => {
  const c = resolveCompanyPermissions({
    systemRole: 'ADMIN',
    overrides: [{ permission: 'roles.manage', grant: false }],
  });
  assert.ok(c.includes('roles.manage'));
});

check('overrides: grants add, denies remove, wrong scope ignored', () => {
  const c = resolveCompanyPermissions({
    systemRole: 'FINANCE',
    overrides: [
      { permission: 'audit.view', grant: true },
      { permission: 'payroll.manage', grant: false },
      { permission: 'projects.create', grant: true },
      { permission: 'hr.attendance', grant: true, workspaceId: 'w1' },
    ],
  });
  assert.ok(c.includes('audit.view'));
  assert.ok(!c.includes('payroll.manage'));
  assert.ok(!c.includes('projects.create'));
  assert.ok(!c.includes('hr.attendance'));
});

check('workspace overrides only apply to their workspace', () => {
  const overrides = [{ permission: 'sales.leads.all', grant: true, workspaceId: 'w1' }];
  assert.ok(resolveWorkspacePermissions({ role: 'MEMBER', overrides, workspaceId: 'w1' }).includes('sales.leads.all'));
  assert.ok(!resolveWorkspacePermissions({ role: 'MEMBER', overrides, workspaceId: 'w2' }).includes('sales.leads.all'));
});

check('workspace sales.leads.all only: full leads, assignee-scoped clients', () => {
  const eff: EffectivePermissions = {
    company: [],
    workspace: [...resolveWorkspacePermissions({ role: 'MEMBER' }), 'sales.leads.all'],
  };
  assert.ok(hasFullLeadAccess({ permissions: eff }));
  assert.ok(!hasFullClientAccess({ permissions: eff }));
  const a = ability('EMPLOYEE', 'MEMBER', eff);
  assert.ok(a.can('create', 'Lead'));
  assert.ok(!a.can('create', 'Client'));
  assert.ok(a.can('read', 'Client'));
});

check('custom workspace role: create leads without seeing all', () => {
  const eff: EffectivePermissions = { company: [], workspace: ['workspace.view', 'sales.leads.create'] };
  const a = ability('EMPLOYEE', 'MEMBER', eff);
  assert.ok(a.can('create', 'Lead'));
  assert.ok(!a.can('delete', 'Lead'));
  assert.ok(!hasFullLeadAccess({ permissions: eff }));
  assert.ok(!a.can('create', 'Project'));
});

// ─── Guardrails ───────────────────────────────────────────────────────────

const ownerEff = presetPermissions({ systemRole: 'EMPLOYEE', workspaceMemberships: [{ role: 'OWNER' }] });
const memberEff = presetPermissions({ systemRole: 'EMPLOYEE', workspaceMemberships: [{ role: 'MEMBER' }] });
const adminEff = presetPermissions({ systemRole: 'ADMIN', workspaceMemberships: [] });

check('workspace owner may assign workspace permissions they hold', () => {
  assert.ok(canAssignWorkspacePermissions(ownerEff, ['sales.leads.all', 'projects.delete']).ok);
});

check('workspace manager may not assign company permissions', () => {
  assert.ok(!canAssignWorkspacePermissions(ownerEff, ['finance.view']).ok);
});

check('member without members.manage may assign nothing', () => {
  assert.ok(!canAssignWorkspacePermissions(memberEff, ['tasks.create']).ok);
});

check('manager may not hand out permissions they lack', () => {
  const limited: EffectivePermissions = { company: [], workspace: ['members.manage', 'tasks.create'] };
  assert.ok(canAssignWorkspacePermissions(limited, ['tasks.create']).ok);
  assert.ok(!canAssignWorkspacePermissions(limited, ['projects.delete']).ok);
});

check('roles.manage may assign any workspace permission', () => {
  assert.ok(canAssignWorkspacePermissions(adminEff, ['members.manage', 'sales.clients.all']).ok);
});

if (failures > 0) {
  console.error(`\n${failures} permission check(s) failed`);
  process.exit(1);
}
console.log('\nall permission checks passed');
