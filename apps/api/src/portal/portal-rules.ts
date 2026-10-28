import type { PortalProgress } from '@botss/shared-types';

import type { PortalContact } from './portal-scope';

/**
 * Pure rules for what the portal shows, kept free of Prisma calls so
 * `scripts/check-portal.ts` can verify them without a database.
 */

/** Project statuses a client sees. Drafts are not started; archived is gone. */
export const PORTAL_PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED'] as const;

/**
 * The client's projects: linked to the client, pinned to the client's own
 * workspace (a stale cross-workspace link must never leak), switched on for
 * the portal, and not a draft or archived.
 */
export function portalProjectWhere(contact: PortalContact) {
  return {
    clientId: contact.clientId,
    workspaceId: contact.workspaceId,
    portalVisible: true,
    deletedAt: null,
    status: { in: [...PORTAL_PROJECT_STATUSES] },
  };
}

/** Tasks listed on a portal project page. Cancelled work is never listed. */
export function portalTaskWhere(projectId: string, showAllTasks: boolean) {
  return {
    projectId,
    deletedAt: null,
    status: { not: 'CANCELLED' as const },
    ...(showAllTasks ? {} : { portalVisible: true }),
  };
}

/**
 * Milestones on a portal project page: from the project's contracts that
 * are live (not draft, cancelled or deleted) and belong to this client (or
 * to no client, in which case the project decides). Cancelled milestones
 * are dropped.
 */
export function portalMilestoneContractWhere(contact: PortalContact, projectId: string) {
  return {
    projectId,
    workspaceId: contact.workspaceId,
    deletedAt: null,
    status: { in: ['ACTIVE' as const, 'COMPLETED' as const] },
    OR: [{ clientId: contact.clientId }, { clientId: null }],
  };
}

/**
 * The client's contracts, for billing: the contract names the client, or
 * names no client and sits on one of the client's projects.
 */
export function portalContractWhere(contact: PortalContact) {
  return {
    workspaceId: contact.workspaceId,
    deletedAt: null,
    status: { not: 'DRAFT' as const },
    OR: [
      { clientId: contact.clientId },
      {
        clientId: null,
        // The project decides, so it must also be switched on for the portal:
        // otherwise linking a project to a client (anyone may) would push its
        // client-less contracts into that client's billing.
        project: {
          clientId: contact.clientId,
          workspaceId: contact.workspaceId,
          deletedAt: null,
          portalVisible: true,
        },
      },
    ],
  };
}

/**
 * Documents a portal person may read: shared with their client company, or
 * with them personally, and always inside the client's own workspace.
 */
export function portalDocumentWhere(contact: PortalContact, userId: string) {
  return {
    workspaceId: contact.workspaceId,
    deletedAt: null,
    OR: [
      { clientShares: { some: { clientId: contact.clientId } } },
      { access: { some: { userId } } },
    ],
  };
}

/** The client's invoices, for billing. Drafts never reach a client. */
export function portalInvoiceWhere(contact: PortalContact) {
  return {
    clientId: contact.clientId,
    workspaceId: contact.workspaceId,
    deletedAt: null,
    status: { not: 'DRAFT' as const },
  };
}

/**
 * May a workspace attach an EXISTING client-portal account? Only when the
 * account lives entirely in this workspace. `elsewhere` / `here` count the
 * account's contact rows (revoked ones included) in other workspaces and in
 * this one. The password is account-wide and workspace admins can mint
 * password links, so anything else would let one workspace's admins take
 * over an account another workspace (or tenant) relies on. An account with a
 * password but no history here had its password set by someone else.
 */
export function portalAccountReusable(counts: {
  elsewhere: number;
  here: number;
  hasPassword: boolean;
}): boolean {
  if (counts.elsewhere > 0) return false;
  return !(counts.hasPassword && counts.here === 0);
}

/** Invoices with money still owed. */
export const PORTAL_OPEN_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;

/**
 * Turn `task.groupBy(['status'])` counts into the portal progress block.
 * `percent` = done / total over every task, the same figure the internal
 * project summary shows.
 */
export function toPortalProgress(
  counts: ReadonlyArray<{ status: string; count: number }>,
): PortalProgress {
  const by = (statuses: string[]) =>
    counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c.count, 0);
  const total = counts.reduce((n, c) => n + c.count, 0);
  const done = by(['DONE']);
  return {
    total,
    notStarted: by(['BACKLOG', 'TODO']),
    inProgress: by(['IN_PROGRESS']),
    inReview: by(['IN_REVIEW']),
    done,
    cancelled: by(['CANCELLED']),
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}
