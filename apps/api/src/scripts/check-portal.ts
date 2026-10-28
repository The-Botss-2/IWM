/**
 * Client-portal self-checks that need no database, Redis or mail server:
 *
 * 1. The boundary: a CLIENT account is refused on every route that is not
 *    marked `@PortalRoute()`, never gets workspace context (and never a
 *    bootstrapped personal workspace), and staff are refused on client-only
 *    routes. Checked on the pure rule AND on the real AuthGuard with fakes.
 * 2. Only three Better Auth routes are reachable.
 * 3. Portal link identifiers round-trip and never collide with workspace
 *    invites.
 * 4. The portal where-builders pin the client's workspace and hide drafts.
 * 5. The allowlist schemas strip internal finance and task fields.
 * 6. Progress matches the internal project summary's formula.
 * 7. Portal emails escape what they interpolate and carry no em-dash.
 * 8. Staff flows refuse to adopt a client account.
 *
 * Run: pnpm --filter @botss/api test (chained after the signature checks).
 */
import 'reflect-metadata';

import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  portalContractSchema,
  portalInvoiceDetailSchema,
  portalMilestoneSchema,
  portalPaymentSchema,
  portalProjectDetailSchema,
  portalTaskSchema,
} from '@botss/shared-types';

import { isAllowedBetterAuthRoute } from '../auth/better-auth-routes';
import { assertNotClientAccount } from '../common/client-accounts';
import { PortalRoute, portalBoundary } from '../common/decorators/portal-route.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { renderClientPortalEmail } from '../email/mail.sender';
import {
  portalAccountReusable,
  portalContractWhere,
  portalDocumentWhere,
  portalInvoiceWhere,
  portalProjectWhere,
  portalTaskWhere,
  toPortalProgress,
} from '../portal/portal-rules';
import { livePortalContactWhere, type PortalContact } from '../portal/portal-scope';
import {
  parsePortalTokenIdentifier,
  portalTokenIdentifier,
  portalTokenIdentifiers,
  portalTokensForUser,
} from '../portal/portal-tokens';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1a. The pure boundary rule
  // -------------------------------------------------------------------------
  check(
    'boundary: client on internal route denied',
    portalBoundary('CLIENT', undefined) === 'deny-client',
  );
  check(
    'boundary: client on portal route allowed',
    portalBoundary('CLIENT', 'client-only') === 'client',
  );
  check('boundary: client on shared route allowed', portalBoundary('CLIENT', 'both') === 'client');
  check(
    'boundary: staff on internal route resolves',
    portalBoundary('STAFF', undefined) === 'staff',
  );
  check('boundary: staff on shared route resolves', portalBoundary('STAFF', 'both') === 'staff');
  check(
    'boundary: staff on client-only route denied',
    portalBoundary('STAFF', 'client-only') === 'deny-staff',
  );

  // -------------------------------------------------------------------------
  // 1b. The real AuthGuard, with a fake AuthService
  // -------------------------------------------------------------------------
  class InternalController {
    handle(): void {}
  }
  class PortalOnlyController {
    handle(): void {}
  }
  PortalRoute()(PortalOnlyController);
  class SharedController {
    handle(): void {}
  }
  PortalRoute('both')(
    SharedController.prototype,
    'handle',
    Object.getOwnPropertyDescriptor(SharedController.prototype, 'handle')!,
  );

  const run = async (
    accountType: 'STAFF' | 'CLIENT',
    controller: { prototype: { handle: () => void } },
  ) => {
    const calls = { context: 0, bootstrap: 0 };
    const fakeAuth = {
      getSessionFromRequest: async () => ({
        user: { id: 'u1', email: 'a@client.test', name: 'A', emailVerified: true, image: null },
        session: { id: 's1' },
      }),
      // One resolution returns the user flags, memberships and permissions.
      // For a CLIENT account it returns a membership on purpose: the guard
      // must still hand the client an empty workspace context.
      resolveRequestContext: async () => {
        calls.context++;
        return {
          extras: {
            systemRole: 'EMPLOYEE',
            organizationId: accountType === 'CLIENT' ? null : 'org1',
            accountType,
            orgInactive: false,
            userDisabled: false,
          },
          session:
            accountType === 'CLIENT'
              ? {
                  currentWorkspaceId: 'w-leak',
                  workspaceMemberships: [{ workspaceId: 'w-leak', role: 'OWNER' }],
                  projectMemberships: [],
                }
              : { currentWorkspaceId: null, workspaceMemberships: [], projectMemberships: [] },
          permissions:
            accountType === 'CLIENT'
              ? { company: ['users.manage'], workspace: ['projects.manage'] }
              : { company: [], workspace: [] },
        };
      },
      ensureBootstrapWorkspace: async () => {
        calls.bootstrap++;
        return 'w1';
      },
    };
    const guard = new AuthGuard(new Reflector(), fakeAuth as never);
    const req: Record<string, unknown> = { headers: {}, method: 'GET', url: '/x' };
    const ctx = {
      getHandler: () => controller.prototype.handle,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    let status: number | null = null;
    let code: unknown = null;
    try {
      await guard.canActivate(ctx);
    } catch (err) {
      if (err instanceof HttpException) {
        status = err.getStatus();
        code = (err.getResponse() as { code?: unknown }).code;
      } else {
        throw err;
      }
    }
    return { status, code, calls, req };
  };

  {
    const r = await run('CLIENT', InternalController);
    check(
      'guard: client refused on an internal route',
      r.status === 403 && r.code === 'portal-only',
      JSON.stringify(r),
    );
    // One context resolution (it carries the accountType), never a bootstrap.
    check(
      'guard: client never bootstraps a workspace',
      r.calls.bootstrap === 0 && r.calls.context === 1,
    );
  }
  {
    const r = await run('CLIENT', PortalOnlyController);
    check('guard: client allowed on a portal route', r.status === null, JSON.stringify(r));
    check(
      'guard: client gets an empty workspace context',
      r.req['workspaceId'] === null &&
        Array.isArray(r.req['workspaceMemberships']) &&
        (r.req['workspaceMemberships'] as unknown[]).length === 0 &&
        Array.isArray(r.req['projectMemberships']) &&
        (r.req['projectMemberships'] as unknown[]).length === 0,
    );
    check(
      'guard: client never receives resolved permissions',
      JSON.stringify(r.req['permissions']) === JSON.stringify({ company: [], workspace: [] }),
      JSON.stringify(r.req['permissions']),
    );
    check(
      'guard: client context skips the bootstrap',
      r.calls.bootstrap === 0 && r.calls.context === 1,
    );
    check(
      'guard: accountType lands on req.user',
      (r.req['user'] as { accountType?: string })?.accountType === 'CLIENT',
    );
  }
  {
    const r = await run('CLIENT', SharedController);
    check(
      'guard: client allowed on /auth/me-style shared route',
      r.status === null,
      JSON.stringify(r),
    );
  }
  {
    const r = await run('STAFF', PortalOnlyController);
    check(
      'guard: staff refused on a client-only route',
      r.status === 403 && r.code === 'client-portal-only',
    );
  }
  {
    const r = await run('STAFF', InternalController);
    // Zero memberships in the fake: the staff path still bootstraps as before.
    check(
      'guard: staff path unchanged (context + bootstrap)',
      r.status === null && r.calls.context === 2 && r.calls.bootstrap === 1,
      JSON.stringify(r.calls),
    );
  }

  // -------------------------------------------------------------------------
  // 2. Better Auth allowlist
  // -------------------------------------------------------------------------
  const open: Array<[string, string]> = [
    ['POST', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/sign-out'],
    ['GET', '/api/auth/get-session'],
    ['HEAD', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-out/'],
  ];
  const closed: Array<[string, string]> = [
    ['POST', '/api/auth/update-user'],
    ['POST', '/api/auth/change-password'],
    ['POST', '/api/auth/change-email'],
    ['POST', '/api/auth/delete-user'],
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/revoke-sessions'],
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/forget-password'],
    ['POST', '/api/auth/request-password-reset'],
    ['POST', '/api/auth/reset-password'],
    ['GET', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/get-session'],
    ['POST', '/api/auth/Update-User'],
    ['POST', '/api/auth/update%2Duser'],
    ['POST', '/api/auth/sign-in/email/../../update-user'],
    ['GET', '/api/v1/auth/me'],
  ];
  for (const [m, p] of open) check(`auth route open: ${m} ${p}`, isAllowedBetterAuthRoute(m, p));
  for (const [m, p] of closed)
    check(`auth route closed: ${m} ${p}`, !isAllowedBetterAuthRoute(m, p));

  // -------------------------------------------------------------------------
  // 3. Portal link identifiers
  // -------------------------------------------------------------------------
  const inv = portalTokenIdentifier('portal-invite', 'cclient1', 'cuser1');
  const rst = portalTokenIdentifier('portal-reset', 'cclient1', 'cuser1');
  const parsedInv = parsePortalTokenIdentifier(inv);
  const parsedRst = parsePortalTokenIdentifier(rst);
  check(
    'token: invite round-trips',
    parsedInv?.kind === 'portal-invite' &&
      parsedInv.clientId === 'cclient1' &&
      parsedInv.userId === 'cuser1',
  );
  check(
    'token: reset round-trips',
    parsedRst?.kind === 'portal-reset' && parsedRst.clientId === 'cclient1',
  );
  check(
    'token: workspace invite is not a portal link',
    parsePortalTokenIdentifier('workspace-invite:w1:u1') === null,
  );
  check(
    'token: malformed rejected',
    parsePortalTokenIdentifier('client-portal-invite:onlyone') === null,
  );
  check(
    'token: extra segment rejected',
    parsePortalTokenIdentifier('client-portal-invite:c:u:x') === null,
  );
  const inviteFilter = portalTokensForUser('portal-invite', 'cuser1');
  check(
    'token: per-user filter matches this person only, one kind',
    inviteFilter.identifier.startsWith === 'client-portal-invite:' &&
      inviteFilter.identifier.endsWith === ':cuser1',
  );
  check(
    'token: revoke covers both kinds',
    portalTokenIdentifiers('c', 'u').length === 2 &&
      portalTokenIdentifiers('c', 'u').includes(portalTokenIdentifier('portal-reset', 'c', 'u')),
  );

  // -------------------------------------------------------------------------
  // 4. Where-builders
  // -------------------------------------------------------------------------
  const contact: PortalContact = {
    contactId: 'k1',
    role: 'MEMBER',
    clientId: 'c1',
    clientName: 'Acme',
    workspaceId: 'w1',
    organizationId: 'o1',
  };
  const pw = portalProjectWhere(contact);
  check(
    'where: project pinned to client + workspace',
    pw.clientId === 'c1' && pw.workspaceId === 'w1',
  );
  check('where: project must be switched on', pw.portalVisible === true && pw.deletedAt === null);
  check(
    'where: drafts and archived projects hidden',
    !pw.status.in.includes('DRAFT' as never) &&
      !pw.status.in.includes('ARCHIVED' as never) &&
      pw.status.in.includes('ACTIVE'),
  );
  check('where: marked tasks only by default', portalTaskWhere('p1', false).portalVisible === true);
  check(
    'where: all tasks mode drops the mark filter',
    !('portalVisible' in portalTaskWhere('p1', true)),
  );
  check(
    'where: cancelled tasks never listed',
    portalTaskWhere('p1', true).status.not === 'CANCELLED',
  );
  const iw = portalInvoiceWhere(contact);
  check(
    'where: invoices pinned and drafts hidden',
    iw.clientId === 'c1' && iw.workspaceId === 'w1' && iw.status.not === 'DRAFT',
  );
  const cw = portalContractWhere(contact);
  check(
    'where: contracts pinned and drafts hidden',
    cw.workspaceId === 'w1' && cw.status.not === 'DRAFT',
  );
  check(
    'where: client-less contract only through the client project',
    JSON.stringify(cw.OR[1]) ===
      JSON.stringify({
        clientId: null,
        project: { clientId: 'c1', workspaceId: 'w1', deletedAt: null, portalVisible: true },
      }),
  );
  const dw = portalDocumentWhere(contact, 'u1');
  check(
    'where: documents pinned to client workspace',
    dw.workspaceId === 'w1' && dw.deletedAt === null,
  );
  check(
    'where: documents shared with company or person',
    JSON.stringify(dw.OR) ===
      JSON.stringify([
        { clientShares: { some: { clientId: 'c1' } } },
        { access: { some: { userId: 'u1' } } },
      ]),
  );
  const lw = livePortalContactWhere('u1');
  check(
    'where: contact must be a CLIENT account',
    lw.user.accountType === 'CLIENT' && lw.user.deletedAt === null,
  );
  check(
    'where: contact org and workspace must be live',
    lw.client.workspace.isActive === true &&
      lw.client.workspace.organization.isActive === true &&
      lw.client.workspace.deletedAt === null &&
      lw.client.deletedAt === null,
  );

  // -------------------------------------------------------------------------
  // 5. Allowlist schemas strip internal fields
  // -------------------------------------------------------------------------
  const leakKeys = [
    'fxRate',
    'fxRateToBase',
    'baseAmount',
    'baseTotalValue',
    'feeAmount',
    'receivedAmount',
    'reference',
    'notesInternal',
    'expenses',
    'assigneeId',
    'assignee',
    'description',
    'estimateHours',
    'createdById',
    'paymentSourceId',
    'voidReason',
  ];
  const withLeaks = <T extends object>(o: T) => ({
    ...o,
    ...Object.fromEntries(leakKeys.map((k) => [k, 'SECRET'])),
  });
  const contract = portalContractSchema.parse(
    withLeaks({
      id: 'cjld2cjxh0000qzrmn831i7rn',
      title: 'Build',
      billingModel: 'MILESTONE',
      status: 'ACTIVE',
      currency: 'USD',
      totalValue: '1000.00',
      amountPaid: '250.00',
      balance: '750.00',
      paymentStatus: 'PARTIAL',
      startDate: null,
      endDate: null,
      projectName: 'Site',
      notes: 'internal contract note',
      milestones: [
        withLeaks({
          id: 'cjld2cjxh0000qzrmn831i7rm',
          title: 'Design',
          amount: '500.00',
          amountPaid: '250.00',
          status: 'DELIVERED',
          paymentStatus: 'PARTIAL',
          dueDate: null,
          deliveredAt: null,
        }),
      ],
    }),
  );
  const contractJson = JSON.stringify(contract);
  check(
    'allowlist: contract drops internal fields',
    !contractJson.includes('SECRET') && !('notes' in contract),
    contractJson,
  );
  const payment = portalPaymentSchema.parse(
    withLeaks({
      id: 'cjld2cjxh0000qzrmn831i7rl',
      amount: '100.00',
      currency: 'USD',
      paidAt: new Date(),
      invoiceNumber: null,
      contractTitle: null,
    }),
  );
  check('allowlist: payment drops fee/fx/reference', !JSON.stringify(payment).includes('SECRET'));
  const invoice = portalInvoiceDetailSchema.parse(
    withLeaks({
      id: 'cjld2cjxh0000qzrmn831i7rk',
      number: 'INV-1',
      status: 'SENT',
      currency: 'USD',
      issuedAt: new Date(),
      dueAt: new Date(),
      total: '10.00',
      amountPaid: '0.00',
      balance: '10.00',
      projectName: null,
      subtotal: '10.00',
      discountAmount: '0.00',
      taxAmount: '0.00',
      notes: 'Thanks for your business',
      terms: null,
      footer: null,
      contractTitle: null,
      lineItems: [],
    }),
  );
  check(
    'allowlist: invoice keeps what the PDF prints only',
    !JSON.stringify(invoice).includes('SECRET') && invoice.notes === 'Thanks for your business',
  );
  const task = portalTaskSchema.parse(
    withLeaks({
      id: 'cjld2cjxh0000qzrmn831i7rj',
      title: 'Homepage',
      status: 'IN_PROGRESS',
      startDate: null,
      dueDate: null,
      completedAt: null,
    }),
  );
  check(
    'allowlist: task drops assignee/description/hours',
    !JSON.stringify(task).includes('SECRET'),
  );
  const milestone = portalMilestoneSchema.parse(
    withLeaks({
      id: 'cjld2cjxh0000qzrmn831i7ri',
      title: 'M1',
      status: 'PENDING',
      dueDate: null,
      deliveredAt: null,
      amount: null,
      currency: null,
      paymentStatus: null,
    }),
  );
  check(
    'allowlist: milestone drops internal fields',
    !JSON.stringify(milestone).includes('SECRET'),
  );
  check(
    'allowlist: project detail has no description or members',
    !('description' in portalProjectDetailSchema.shape) &&
      !('members' in portalProjectDetailSchema.shape),
  );

  // -------------------------------------------------------------------------
  // 6. Progress
  // -------------------------------------------------------------------------
  const p = toPortalProgress([
    { status: 'BACKLOG', count: 2 },
    { status: 'TODO', count: 1 },
    { status: 'IN_PROGRESS', count: 3 },
    { status: 'IN_REVIEW', count: 1 },
    { status: 'DONE', count: 2 },
    { status: 'CANCELLED', count: 1 },
  ]);
  check(
    'progress: buckets add up to total',
    p.notStarted + p.inProgress + p.inReview + p.done + p.cancelled === p.total && p.total === 10,
  );
  check(
    'progress: same formula as the internal summary (done / all)',
    p.percent === Math.round((2 / 10) * 100),
  );
  check(
    'progress: empty project is 0%',
    toPortalProgress([]).percent === 0 && toPortalProgress([]).total === 0,
  );

  // -------------------------------------------------------------------------
  // 7. Portal emails
  // -------------------------------------------------------------------------
  for (const variant of ['invite', 'access', 'reset'] as const) {
    const mail = renderClientPortalEmail({
      variant,
      recipientName: '<b>Ann</b>',
      agencyName: 'Botss & Co',
      clientName: 'Acme <Ltd>',
      inviterName: 'Zed',
      url: 'https://app.test/invitations/accept?token=abc&x="y"',
      expiresAtLabel: variant === 'access' ? null : '1 October 2026',
    });
    const all = `${mail.subject}\n${mail.html}\n${mail.text}`;
    check(`email ${variant}: no em-dash`, !all.includes(String.fromCharCode(0x2014)));
    check(
      `email ${variant}: names escaped in html`,
      !mail.html.includes('<b>Ann</b>') && !mail.html.includes('Acme <Ltd>'),
    );
    check(`email ${variant}: url attribute escaped`, !mail.html.includes('x="y"'));
    check(`email ${variant}: subject is one line`, !/[\r\n]/.test(mail.subject));
  }

  // -------------------------------------------------------------------------
  // 8. Staff flows refuse client accounts; one portal account, one workspace
  // -------------------------------------------------------------------------
  check(
    'reuse: brand-new account (no contacts, no password) allowed',
    portalAccountReusable({ elsewhere: 0, here: 0, hasPassword: false }),
  );
  check(
    'reuse: account already in this workspace allowed',
    portalAccountReusable({ elsewhere: 0, here: 2, hasPassword: true }),
  );
  check(
    'reuse: revoked-here account without password allowed',
    portalAccountReusable({ elsewhere: 0, here: 1, hasPassword: false }),
  );
  check(
    'reuse: account in another workspace refused (takeover)',
    !portalAccountReusable({ elsewhere: 1, here: 0, hasPassword: true }),
  );
  check(
    'reuse: account in another workspace refused even without password',
    !portalAccountReusable({ elsewhere: 1, here: 0, hasPassword: false }),
  );
  check(
    'reuse: account in both workspaces refused',
    !portalAccountReusable({ elsewhere: 1, here: 1, hasPassword: true }),
  );
  check(
    'reuse: password set elsewhere with no history here refused (pre-hijack)',
    !portalAccountReusable({ elsewhere: 0, here: 0, hasPassword: true }),
  );

  let refused = false;
  try {
    assertNotClientAccount('CLIENT');
  } catch (err) {
    refused = err instanceof HttpException && err.getStatus() === 409;
  }
  check('adopt: client account refused with 409', refused);
  let staffOk = true;
  try {
    assertNotClientAccount('STAFF');
    assertNotClientAccount(null);
  } catch {
    staffOk = false;
  }
  check('adopt: staff and unknown pass', staffOk);
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`Portal checks: ${failures} failed.`);
      process.exit(1);
    }
    console.log('Portal checks: all passed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Portal checks crashed:', err);
    process.exit(1);
  });
