/**
 * Security self-checks that need no database, Redis or network.
 *
 * 1. Workspace invitations: link tokens are 256-bit, the old 6-digit links
 *    are refused by the route schema, codes are a separate second factor,
 *    and password rules live in the Zod schema.
 * 2. Project membership ability overrides: allowlisted subjects/actions only,
 *    pinned to the membership's project, also for rows stored before.
 * 3. Row-level delete: conditional rules that pass the subject-only guard
 *    are re-checked against the row (tasks, files, projects).
 *
 * Run: pnpm --filter @botss/api test.
 */
import 'reflect-metadata';

import { defineAbilityFor, presetPermissions, scopeProjectAbilityRules } from '@botss/auth';
import {
  acceptInvitationSchema,
  invitationToken,
  isAllowedPushEndpoint,
  projectAbilityRuleSchema,
  projectAbilityRulesSchema,
  subscribePushSchema,
  updateUserSchema,
  verifyInvitationSchema,
} from '@botss/shared-types';

import { assertMayAdministerUser } from '../admin/admin-user-policy';
import { accessCodeMatches, newAccessCode, newLinkToken } from '../common/access-code';
import { abilityRow } from '../common/permissions/request-ability';
import { assertMayRunTestEmail, mailHealthOrgId } from '../email/email-admin-policy';
import { generalFileVisibility } from '../files/files.service';
import { MailHostRefusedError, resolvePublicHost } from '../mail/mail-ssrf';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import {
  invitationIdentifier,
  parseInvitationIdentifier,
} from '../invitations/invitation-tokens';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. Workspace invitations
// ---------------------------------------------------------------------------

{
  for (let i = 0; i < 100; i++) {
    const t = newLinkToken();
    check('invite: link token accepted by the route', invitationToken.safeParse(t.raw).success, t.raw);
    check('invite: link token is 43 chars', t.raw.length === 43);
  }
  check('invite: legacy 64-hex portal token accepted', invitationToken.safeParse('a'.repeat(64)).success);
  for (const bad of ['842-195', '842195', '520140', 'A'.repeat(42), 'Z'.repeat(64), '../x', '']) {
    check(`invite: '${bad}' refused by the route`, !invitationToken.safeParse(bad).success);
  }

  const id = invitationIdentifier('ws_1', 'user_1');
  const parsed = parseInvitationIdentifier(id);
  check('invite: identifier round-trips', parsed?.workspaceId === 'ws_1' && parsed.userId === 'user_1');
  check('invite: foreign identifier ignored', parseInvitationIdentifier('portal-invite:a:b') === null);

  const code = newAccessCode();
  check('invite: code matches', accessCodeMatches(code.raw, code.hash));
  check('invite: code is not the token', invitationToken.safeParse(code.raw).success === false);

  check('invite: short password refused by Zod', !acceptInvitationSchema.safeParse({ password: 'short' }).success);
  check('invite: long password refused by Zod', !acceptInvitationSchema.safeParse({ password: 'x'.repeat(129) }).success);
  check(
    'invite: password + code accepted',
    acceptInvitationSchema.safeParse({ password: 'long-enough', code: '123-456' }).success,
  );
  check(
    'invite: malformed code refused',
    !acceptInvitationSchema.safeParse({ password: 'long-enough', code: '12-34' }).success,
  );
  check('invite: verify without code parses (portal links)', verifyInvitationSchema.safeParse({}).success);
  check('invite: verify normalises the code', verifyInvitationSchema.parse({ code: '123 456' }).code === '123456');
}

// ---------------------------------------------------------------------------
// 2. Project membership ability overrides
// ---------------------------------------------------------------------------

{
  const refused = [
    { action: 'manage', subject: 'all' },
    { action: 'read', subject: 'all' },
    { action: 'manage', subject: 'Task' },
    { action: 'read', subject: 'Invoice' },
    { action: 'read', subject: 'Payroll' },
    { action: 'update', subject: 'ProjectMembership' },
    { action: 'update', subject: 'WorkspaceMembership' },
    { action: 'delete', subject: 'User' },
    { action: ['read', 'manage'], subject: 'Task' },
    { action: 'read', subject: ['Task', 'all'] },
    { action: 'read', subject: 'Task', extra: true },
  ];
  for (const r of refused) {
    check(`abilities: refused ${JSON.stringify(r)}`, !projectAbilityRuleSchema.safeParse(r).success);
  }
  check(
    'abilities: project CRUD accepted',
    projectAbilityRulesSchema.safeParse([
      { action: 'update', subject: 'Task' },
      { action: ['create', 'read'], subject: ['Document', 'Project'] },
      { action: 'delete', subject: 'Document', inverted: true, reason: 'append only' },
    ]).success,
  );

  // Pinning: caller conditions are discarded and replaced by this project.
  const pinned = scopeProjectAbilityRules(
    [
      { action: 'update', subject: 'Task', conditions: { projectId: 'other' } },
      { action: 'read', subject: ['Project', 'Document'], conditions: { $where: 'x' } },
      { action: 'manage', subject: 'all' }, // stored before the allowlist: dropped
    ],
    'p1',
  );
  check('abilities: invalid stored rule dropped', pinned.length === 3, JSON.stringify(pinned));
  check(
    'abilities: Task pinned to projectId',
    pinned.some((r) => r.subject === 'Task' && JSON.stringify(r.conditions) === '{"projectId":"p1"}'),
  );
  check(
    'abilities: Project pinned to id',
    pinned.some((r) => r.subject === 'Project' && JSON.stringify(r.conditions) === '{"id":"p1"}'),
  );
  check('abilities: non-array is empty', scopeProjectAbilityRules({ action: 'read' }, 'p1').length === 0);

  // End to end through the factory: a VIEWER whose stored overrides try to
  // escalate gets only what the allowlist and pinning leave.
  const ability = defineAbilityFor({
    userId: 'u1',
    systemRole: 'EMPLOYEE',
    permissions: { company: [], workspace: [] },
    workspaceMemberships: [],
    projectMemberships: [
      {
        projectId: 'p1',
        workspaceId: 'w1',
        role: 'VIEWER',
        abilities: [
          { action: 'manage', subject: 'all' },
          { action: 'read', subject: 'Invoice' },
          { action: 'update', subject: 'Task', conditions: { projectId: 'p2' } },
        ],
      },
    ],
  });
  check('abilities: no manage all', !ability.can('manage', 'all'));
  check('abilities: no workspace delete', !ability.can('delete', 'Workspace'));
  check('abilities: no invoice read', !ability.can('read', 'Invoice'));
  check(
    'abilities: task update in own project',
    ability.can('update', abilityRow('Task', { projectId: 'p1' })),
  );
  check(
    'abilities: no task update in the project named by the stored condition',
    !ability.can('update', abilityRow('Task', { projectId: 'p2' })),
  );
}

// ---------------------------------------------------------------------------
// 3. Row-level delete checks (tasks / files / projects)
// ---------------------------------------------------------------------------

{
  const member = defineAbilityFor({
    userId: 'me',
    systemRole: 'EMPLOYEE',
    permissions: presetPermissions({ systemRole: 'EMPLOYEE', workspaceMemberships: [{ role: 'MEMBER' }] }),
    workspaceMemberships: [{ workspaceId: 'w1', role: 'MEMBER' }],
    projectMemberships: [{ projectId: 'led', workspaceId: 'w1', role: 'PROJECT_LEAD', abilities: null }],
  });
  const admin = defineAbilityFor({
    userId: 'boss',
    systemRole: 'EMPLOYEE',
    permissions: presetPermissions({ systemRole: 'EMPLOYEE', workspaceMemberships: [{ role: 'ADMIN' }] }),
    workspaceMemberships: [{ workspaceId: 'w1', role: 'ADMIN' }],
    projectMemberships: [],
  });

  // The guard's bare-subject check passes for all of these...
  check('delete: guard-level Task passes for a member', member.can('delete', 'Task'));
  check('delete: guard-level FileObject passes for a member', member.can('delete', 'FileObject'));
  check('delete: guard-level Project passes for a lead', member.can('delete', 'Project'));

  // ...the row-level checks in the services do not.
  const task = (createdById: string, projectId: string) =>
    abilityRow('Task', { id: 't', createdById, projectId });
  check('delete: own task', member.can('delete', task('me', 'p1')));
  check('delete: someone else\'s task refused', !member.can('delete', task('other', 'p1')));
  check('delete: any task in the project I lead', member.can('delete', task('other', 'led')));
  check('delete: admin deletes any task', admin.can('delete', task('other', 'p1')));

  const file = (uploadedById: string) => abilityRow('FileObject', { id: 'f', uploadedById });
  check('delete: own file', member.can('delete', file('me')));
  check('delete: someone else\'s file refused', !member.can('delete', file('other')));
  check('delete: admin deletes any file', admin.can('delete', file('other')));

  const project = (id: string) => abilityRow('Project', { id });
  check('delete: the project I lead', member.can('delete', project('led')));
  check('delete: another project refused', !member.can('delete', project('p1')));
  check('delete: admin deletes any project', admin.can('delete', project('p1')));
}

// ---------------------------------------------------------------------------
// 4. General /files visibility
// ---------------------------------------------------------------------------

{
  const staff = generalFileVisibility(false);
  const finance = generalFileVisibility(true);
  check('files: receipts hidden without finance', 'expenseReceipts' in staff);
  check('files: invoice PDFs hidden without finance', 'invoicePdfs' in staff);
  check('files: finance sees receipts', !('expenseReceipts' in finance) && !('invoicePdfs' in finance));
  for (const rel of ['signatureImages', 'signatureSources', 'signatureSealed', 'mailAttachments']) {
    check(`files: ${rel} hidden for everyone`, rel in staff && rel in finance);
  }
}

// ---------------------------------------------------------------------------
// 5. Admin email endpoints
// ---------------------------------------------------------------------------

{
  const throws = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const none = { company: [], workspace: [] };
  const usersManage = { company: ['users.manage'], workspace: [] };
  const tenantAdmin = { email: 'a@acme.test', systemRole: 'ADMIN', organizationId: 'org_acme' };
  const rootAdmin = { email: 'ops@example.com', systemRole: 'ADMIN', organizationId: ROOT_ORG_ID };
  const superAdmin = { email: 'root@example.com', systemRole: 'SUPER_ADMIN', organizationId: ROOT_ORG_ID };

  check('email test: tenant admin refused', throws(() => assertMayRunTestEmail(tenantAdmin, usersManage, tenantAdmin.email)));
  check('email test: root user without users.manage refused', throws(() => assertMayRunTestEmail(rootAdmin, none, rootAdmin.email)));
  check('email test: root users.manage to self', !throws(() => assertMayRunTestEmail(rootAdmin, usersManage, 'OPS@example.com')));
  check('email test: root users.manage to a stranger refused', throws(() => assertMayRunTestEmail(rootAdmin, usersManage, 'victim@example.com')));
  check('email test: super admin to anyone', !throws(() => assertMayRunTestEmail(superAdmin, none, 'anyone@example.com')));

  check('email health: tenant pinned to own org', mailHealthOrgId(tenantAdmin) === 'org_acme');
  check('email health: super admin sees the platform transport', mailHealthOrgId(superAdmin) === undefined);
}

// ---------------------------------------------------------------------------
// 6. Admin user management tiers
// ---------------------------------------------------------------------------

{
  const throws = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const base = { actorId: 'a', targetId: 't', actorHasRolesManage: true };
  check(
    'admin: HR with users.manage cannot reset an ADMIN',
    throws(() => assertMayAdministerUser({ ...base, actorRole: 'HR', targetRole: 'ADMIN' })),
  );
  check(
    'admin: ADMIN cannot edit a SUPER_ADMIN',
    throws(() => assertMayAdministerUser({ ...base, actorRole: 'ADMIN', targetRole: 'SUPER_ADMIN' })),
  );
  check(
    'admin: ADMIN edits an ADMIN',
    !throws(() => assertMayAdministerUser({ ...base, actorRole: 'ADMIN', targetRole: 'ADMIN' })),
  );
  check(
    'admin: HR edits an EMPLOYEE',
    !throws(() => assertMayAdministerUser({ ...base, actorRole: 'HR', targetRole: 'EMPLOYEE' })),
  );
  check(
    'admin: no self role change',
    throws(() =>
      assertMayAdministerUser({ ...base, targetId: 'a', actorRole: 'ADMIN', targetRole: 'ADMIN', newRole: 'SUPER_ADMIN' }),
    ),
  );
  check(
    'admin: role change needs roles.manage',
    throws(() =>
      assertMayAdministerUser({ ...base, actorHasRolesManage: false, actorRole: 'ADMIN', targetRole: 'EMPLOYEE', newRole: 'HR' }),
    ),
  );
  check(
    'admin: cannot grant above own tier',
    throws(() => assertMayAdministerUser({ ...base, actorRole: 'HR', targetRole: 'EMPLOYEE', newRole: 'ADMIN' })),
  );
  check(
    'admin: ADMIN with roles.manage changes a role',
    !throws(() => assertMayAdministerUser({ ...base, actorRole: 'ADMIN', targetRole: 'EMPLOYEE', newRole: 'HR' })),
  );
  check(
    'admin: unchanged role is not a role change',
    !throws(() =>
      assertMayAdministerUser({ ...base, targetId: 'a', actorHasRolesManage: false, actorRole: 'ADMIN', targetRole: 'ADMIN', newRole: 'ADMIN' }),
    ),
  );
}

// ---------------------------------------------------------------------------
// 7. Web Push endpoints (SSRF)
// ---------------------------------------------------------------------------

{
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-db5p.notify.windows.com/w/?token=x',
    'https://web.push.apple.com/QGx',
    'https://api.push.apple.com/3/device/x',
  ];
  const bad = [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:8443/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'https://evil.example.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x',
    'https://push.services.mozilla.com.evil.com/x',
    'https://user:pw@fcm.googleapis.com/x',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const u of ok) check(`push: allowed ${u}`, isAllowedPushEndpoint(u));
  for (const u of bad) check(`push: refused ${u}`, !isAllowedPushEndpoint(u));
  check(
    'push: schema refuses internal endpoint',
    !subscribePushSchema.safeParse({ endpoint: 'https://10.0.0.5/x', auth: 'a', p256dh: 'b' }).success,
  );
}

// ---------------------------------------------------------------------------
// 8. Avatar URLs
// ---------------------------------------------------------------------------

{
  check('avatar: https accepted', updateUserSchema.safeParse({ image: 'https://cdn.example.com/a.png' }).success);
  check('avatar: null clears', updateUserSchema.safeParse({ image: null }).success);
  for (const bad of ['http://cdn.example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) {
    check(`avatar: refused ${bad}`, !updateUserSchema.safeParse({ image: bad }).success);
  }
}

// ---------------------------------------------------------------------------
// 9. Mail host refusals are typed (mapped to 400 at the HTTP layer)
// ---------------------------------------------------------------------------

async function asyncChecks(): Promise<void> {
  for (const host of ['127.0.0.1', '10.1.2.3', '2130706433', '']) {
    const err = await resolvePublicHost(host).then(
      () => null,
      (e: unknown) => e,
    );
    check(`mail host: '${host}' refused with MailHostRefusedError`, err instanceof MailHostRefusedError);
  }
}

void asyncChecks().then(() => {
  if (failures > 0) {
    console.error(`Security checks: ${failures} failed.`);
    process.exit(1);
  }
  console.log('Security checks: all passed.');
});
