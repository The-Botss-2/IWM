import { BadRequestException } from '@nestjs/common';
import type {
  ClientActivityItem,
  ClientBillingCurrency,
  ClientDocumentLink,
} from '@botss/shared-types';

import { D, money, type Decimal } from '../finance/serialize';

/**
 * Pure rules behind the client hub (documents, signatures, billing summary,
 * activity feed). No Prisma calls, so `scripts/check-client-hub.ts` can check
 * them without a database.
 */

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentViewer {
  userId: string;
  /** Role in the ACTIVE workspace. */
  workspaceRole: string | null | undefined;
}

export function isWorkspaceAdminRole(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * Documents this viewer may read: the same rule as DocumentsService.get -
 * creator, workspace owner/admin, or an explicit DocumentAccess grant.
 * Returns `{}` for admins so it can be AND-ed unconditionally.
 */
export function documentReadWhere(viewer: DocumentViewer): Record<string, unknown> {
  if (isWorkspaceAdminRole(viewer.workspaceRole)) return {};
  return {
    OR: [{ createdById: viewer.userId }, { access: { some: { userId: viewer.userId } } }],
  };
}

/**
 * Documents that belong on a client's page: filed under it, in one of its
 * (live) projects, shared with the company, or personally shared with one of
 * its portal people. Nested `deletedAt: null` is written by hand because the
 * soft-delete extension only filters the top-level model.
 */
export function clientDocumentRelationWhere(
  clientId: string,
  contactUserIds: readonly string[],
): Record<string, unknown> {
  const ors: Record<string, unknown>[] = [
    { clientId },
    { project: { clientId, deletedAt: null } },
    { clientShares: { some: { clientId } } },
  ];
  if (contactUserIds.length > 0) {
    ors.push({ access: { some: { userId: { in: [...contactUserIds] } } } });
  }
  return { OR: ors };
}

/** Every reason a loaded document is on the client page, strongest first. */
export function clientDocumentLinks(
  clientId: string,
  doc: {
    clientId: string | null;
    projectClientId: string | null;
    companyShared: boolean;
    peopleShared: number;
  },
): ClientDocumentLink[] {
  const links: ClientDocumentLink[] = [];
  if (doc.clientId === clientId) links.push('FILED');
  if (doc.projectClientId === clientId) links.push('PROJECT');
  if (doc.companyShared || doc.peopleShared > 0) links.push('SHARED');
  return links;
}

/** Viewer permission on one loaded document (same order as DocumentsService). */
export function documentViewerPermission(
  viewer: DocumentViewer,
  doc: { createdById: string },
  grant: 'READ' | 'WRITE' | null,
): 'OWNER' | 'ADMIN' | 'WRITE' | 'READ' {
  if (doc.createdById === viewer.userId) return 'OWNER';
  if (isWorkspaceAdminRole(viewer.workspaceRole)) return 'ADMIN';
  return grant === 'WRITE' ? 'WRITE' : 'READ';
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Signature requests on a client's page: the source document is filed under
 * the client or sits in one of its projects, or someone at the client (any
 * portal person, revoked ones included) is a signer. Drafts are the
 * requester's private work and never listed.
 */
export function clientSignatureRelationWhere(
  clientId: string,
  contactEmails: readonly string[],
): Record<string, unknown> {
  const ors: Record<string, unknown>[] = [
    { document: { deletedAt: null, clientId } },
    { document: { deletedAt: null, project: { clientId, deletedAt: null } } },
  ];
  const emails = [...new Set(contactEmails.map((e) => e.toLowerCase()))];
  if (emails.length > 0) ors.push({ signers: { some: { email: { in: emails } } } });
  return { status: { not: 'DRAFT' }, OR: ors };
}

// ---------------------------------------------------------------------------
// Billing summary
// ---------------------------------------------------------------------------

type Money = Decimal | string | number;

export const ISSUED_INVOICE_EXCLUDED = ['DRAFT', 'CANCELLED'] as const;
export const OPEN_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;
export const COUNTED_CONTRACT_STATUSES = ['ACTIVE', 'COMPLETED'] as const;

export interface BillingInvoiceRow {
  currency: string;
  status: string;
  total: Money;
  amountPaid: Money;
  dueAt: Date;
}
export interface BillingContractRow {
  currency: string;
  status: string;
  totalValue: Money;
  amountPaid: Money;
}
export interface BillingPaymentSum {
  currency: string;
  amount: Money | null;
  count: number;
}

function clampedBalance(total: Money, paid: Money): Decimal {
  const b = new D(total).minus(new D(paid));
  return b.isNegative() ? new D(0) : b;
}

/**
 * Per-currency totals. Invoice and contract views are kept apart (an invoice
 * raised against a contract is the same money twice), and a single overpaid
 * row never offsets another row's balance.
 */
export function summarizeClientBilling(
  input: {
    invoices: readonly BillingInvoiceRow[];
    contracts: readonly BillingContractRow[];
    payments: readonly BillingPaymentSum[];
  },
  now: Date = new Date(),
): {
  byCurrency: ClientBillingCurrency[];
  counts: {
    invoices: number;
    openInvoices: number;
    overdueInvoices: number;
    contracts: number;
    payments: number;
  };
} {
  type Acc = Record<
    | 'invoiced'
    | 'invoicePaid'
    | 'invoiceOutstanding'
    | 'contracted'
    | 'contractOutstanding'
    | 'received',
    Decimal
  >;
  const by = new Map<string, Acc>();
  const acc = (currency: string): Acc => {
    let a = by.get(currency);
    if (!a) {
      a = {
        invoiced: new D(0),
        invoicePaid: new D(0),
        invoiceOutstanding: new D(0),
        contracted: new D(0),
        contractOutstanding: new D(0),
        received: new D(0),
      };
      by.set(currency, a);
    }
    return a;
  };
  const counts = { invoices: 0, openInvoices: 0, overdueInvoices: 0, contracts: 0, payments: 0 };

  for (const inv of input.invoices) {
    if ((ISSUED_INVOICE_EXCLUDED as readonly string[]).includes(inv.status)) continue;
    const a = acc(inv.currency);
    counts.invoices++;
    a.invoiced = a.invoiced.plus(new D(inv.total));
    a.invoicePaid = a.invoicePaid.plus(new D(inv.amountPaid));
    if ((OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status)) {
      counts.openInvoices++;
      a.invoiceOutstanding = a.invoiceOutstanding.plus(clampedBalance(inv.total, inv.amountPaid));
      if (inv.status === 'OVERDUE' || inv.dueAt.getTime() < now.getTime()) counts.overdueInvoices++;
    }
  }
  for (const c of input.contracts) {
    if (!(COUNTED_CONTRACT_STATUSES as readonly string[]).includes(c.status)) continue;
    const a = acc(c.currency);
    counts.contracts++;
    a.contracted = a.contracted.plus(new D(c.totalValue));
    a.contractOutstanding = a.contractOutstanding.plus(clampedBalance(c.totalValue, c.amountPaid));
  }
  for (const p of input.payments) {
    const a = acc(p.currency);
    counts.payments += p.count;
    a.received = a.received.plus(new D(p.amount ?? 0));
  }

  const byCurrency = [...by.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([currency, a]) => ({
      currency,
      invoiced: money(a.invoiced),
      invoicePaid: money(a.invoicePaid),
      invoiceOutstanding: money(a.invoiceOutstanding),
      contracted: money(a.contracted),
      contractOutstanding: money(a.contractOutstanding),
      received: money(a.received),
    }));
  return { byCurrency, counts };
}

// ---------------------------------------------------------------------------
// Cursors and the merged activity feed
// ---------------------------------------------------------------------------

/**
 * A position in a feed ordered by (at DESC, source DESC, rowId DESC).
 * `source` names the table/kind the row came from, so rows from different
 * tables that share a timestamp still have a total order.
 */
export interface FeedCursor {
  at: Date;
  source: string;
  rowId: string;
}

export function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify([c.at.getTime(), c.source, c.rowId]), 'utf8').toString(
    'base64url',
  );
}

function badCursor(): BadRequestException {
  return new BadRequestException({
    title: 'Invalid cursor',
    status: 400,
    detail: 'The page cursor is malformed. Reload the list from the start.',
  });
}

export function decodeCursor(raw: string | undefined): FeedCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'number' ||
    !Number.isFinite(parsed[0]) ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    parsed[1].length > 40 ||
    parsed[2].length > 64
  ) {
    throw badCursor();
  }
  return { at: new Date(parsed[0]), source: parsed[1], rowId: parsed[2] };
}

/** Negative when `a` sorts before `b` (newer first). */
export function compareFeed(a: FeedCursor, b: FeedCursor): number {
  const dt = b.at.getTime() - a.at.getTime();
  if (dt !== 0) return dt;
  if (a.source !== b.source) return a.source > b.source ? -1 : 1;
  if (a.rowId !== b.rowId) return a.rowId > b.rowId ? -1 : 1;
  return 0;
}

/** True when `item` comes strictly after the cursor (i.e. on a later page). */
export function isAfterCursor(item: FeedCursor, cursor: FeedCursor | null): boolean {
  return cursor === null || compareFeed(cursor, item) < 0;
}

/**
 * Where-fragment selecting one source's rows that come after the cursor, for
 * a query ordered by `[field] DESC, id DESC`. Exact keyset, so ties on the
 * timestamp across pages are neither skipped nor repeated.
 */
export function keysetWhere(
  source: string,
  field: string,
  cursor: FeedCursor | null,
): Record<string, unknown> {
  if (!cursor) return {};
  if (source < cursor.source) return { [field]: { lte: cursor.at } };
  if (source > cursor.source) return { [field]: { lt: cursor.at } };
  return {
    OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.rowId } }],
  };
}

/** One activity row before merging: the public item plus its sort key. */
export interface FeedEntry {
  key: FeedCursor;
  item: ClientActivityItem;
}

/**
 * Merge per-source pages into one page. Each source must have returned up to
 * `limit + 1` rows after the cursor; then the newest `limit` of the union are
 * exactly the next page, and anything left over means there is more.
 */
export function mergeFeed(
  sources: ReadonlyArray<readonly FeedEntry[]>,
  limit: number,
  cursor: FeedCursor | null,
): { items: ClientActivityItem[]; nextCursor: string | null } {
  const all = sources
    .flat()
    .filter((e) => isAfterCursor(e.key, cursor))
    .sort((a, b) => compareFeed(a.key, b.key));
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((e) => e.item),
    nextCursor: all.length > limit && last ? encodeCursor(last.key) : null,
  };
}

/** Build an entry; the item id is `<source>:<rowId>`, unique across sources. */
export function feedEntry(
  source: string,
  rowId: string,
  at: Date,
  item: Omit<ClientActivityItem, 'id' | 'at'>,
): FeedEntry {
  return { key: { at, source, rowId }, item: { id: `${source}:${rowId}`, at, ...item } };
}
