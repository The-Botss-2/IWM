/**
 * Client hub self-checks that need no database:
 *
 * 1. Client visibility: finance roles READ every client in the workspace but
 *    never WRITE one they are not assigned; everything stays workspace-pinned.
 * 2. Document and signature where-builders: read rule, client relation,
 *    drafts excluded, nested soft-delete written by hand.
 * 3. PRIVATE project names are gated in memory.
 * 4. Billing summary math: per currency, invoice vs contract kept apart,
 *    drafts/cancelled ignored, overpayment never offsets another row.
 * 5. Activity cursors round-trip, reject garbage, and the merged feed pages
 *    with no gaps and no repeats, ties on the timestamp included.
 * 6. Custom field values: SELECT options, types, and which scopes the
 *    generic value routes serve.
 *
 * Run: pnpm --filter @botss/api test (chained after the other checks).
 */
import 'reflect-metadata';

import { HttpException } from '@nestjs/common';
import { clientActivityListSchema, clientBillingSummarySchema } from '@botss/shared-types';

import {
  clientDocumentLinks,
  clientDocumentRelationWhere,
  clientSignatureRelationWhere,
  decodeCursor,
  documentReadWhere,
  documentViewerPermission,
  encodeCursor,
  type FeedCursor,
  type FeedEntry,
  feedEntry,
  isAfterCursor,
  keysetWhere,
  mergeFeed,
  summarizeClientBilling,
} from '../clients/client-hub-rules';
import { clientVisibleWhere, clientWritableWhere } from '../clients/client-visibility';
import { canSeeProject } from '../common/project-access';
import { customFieldValueProblem, isGenericValueScope } from '../custom-fields/custom-field-rules';
import { clientContractWhere, clientPaymentWhere } from '../finance/client-finance-where';
import { signatureVisibleWhere } from '../signatures/signature-visibility';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkVisibility(): void {
  const base = { userId: 'u1', workspaceId: 'w1' };
  const member = { ...base, fullClients: false, financeAccess: false };
  const finance = { ...base, fullClients: false, financeAccess: true };
  const sales = { ...base, fullClients: true, financeAccess: false };

  check(
    'visible: member pinned to assignee',
    eq(clientVisibleWhere(member), { workspaceId: 'w1', assigneeId: 'u1' }),
  );
  check(
    'visible: finance reads whole workspace',
    eq(clientVisibleWhere(finance), { workspaceId: 'w1' }),
  );
  check(
    'visible: sales reads whole workspace',
    eq(clientVisibleWhere(sales), { workspaceId: 'w1' }),
  );
  check(
    'writable: finance stays pinned to assignee',
    eq(clientWritableWhere(finance), { workspaceId: 'w1', assigneeId: 'u1' }),
  );
  check('writable: sales whole workspace', eq(clientWritableWhere(sales), { workspaceId: 'w1' }));
  check(
    'writable: member pinned',
    eq(clientWritableWhere(member), { workspaceId: 'w1', assigneeId: 'u1' }),
  );
}

function checkDocuments(): void {
  check(
    'doc read: admin unrestricted',
    eq(documentReadWhere({ userId: 'u', workspaceRole: 'ADMIN' }), {}),
  );
  check(
    'doc read: owner unrestricted',
    eq(documentReadWhere({ userId: 'u', workspaceRole: 'OWNER' }), {}),
  );
  check(
    'doc read: member = creator or grant',
    eq(documentReadWhere({ userId: 'u', workspaceRole: 'MEMBER' }), {
      OR: [{ createdById: 'u' }, { access: { some: { userId: 'u' } } }],
    }),
  );

  const rel = clientDocumentRelationWhere('c1', []) as { OR: unknown[] };
  check('doc relation: no people branch without contacts', rel.OR.length === 3);
  check(
    'doc relation: project branch filters deleted projects',
    eq(rel.OR[1], { project: { clientId: 'c1', deletedAt: null } }),
  );
  const relP = clientDocumentRelationWhere('c1', ['p1']) as { OR: unknown[] };
  check('doc relation: people branch with contacts', relP.OR.length === 4);

  check(
    'doc links: filed + project + shared in order',
    eq(
      clientDocumentLinks('c1', {
        clientId: 'c1',
        projectClientId: 'c1',
        companyShared: false,
        peopleShared: 1,
      }),
      ['FILED', 'PROJECT', 'SHARED'],
    ),
  );
  check(
    'doc links: filed elsewhere is not FILED here',
    eq(
      clientDocumentLinks('c1', {
        clientId: 'c2',
        projectClientId: null,
        companyShared: true,
        peopleShared: 0,
      }),
      ['SHARED'],
    ),
  );

  const viewer = { userId: 'u', workspaceRole: 'MEMBER' };
  check(
    'perm: creator owns',
    documentViewerPermission(viewer, { createdById: 'u' }, null) === 'OWNER',
  );
  check(
    'perm: write grant',
    documentViewerPermission(viewer, { createdById: 'x' }, 'WRITE') === 'WRITE',
  );
  check(
    'perm: read grant',
    documentViewerPermission(viewer, { createdById: 'x' }, 'READ') === 'READ',
  );
  check(
    'perm: admin',
    documentViewerPermission(
      { userId: 'u', workspaceRole: 'ADMIN' },
      { createdById: 'x' },
      null,
    ) === 'ADMIN',
  );

  const scope = { userId: 'u', projectIds: ['p-member'], seesEveryProject: false };
  check(
    'project: workspace project visible',
    canSeeProject(scope, { id: 'p', visibility: 'WORKSPACE', createdById: 'x' }),
  );
  check(
    'project: private hidden',
    !canSeeProject(scope, { id: 'p', visibility: 'PRIVATE', createdById: 'x' }),
  );
  check(
    'project: private member sees',
    canSeeProject(scope, { id: 'p-member', visibility: 'PRIVATE', createdById: 'x' }),
  );
  check(
    'project: private creator sees',
    canSeeProject(scope, { id: 'p', visibility: 'PRIVATE', createdById: 'u' }),
  );
  check(
    'project: admin sees private',
    canSeeProject(
      { ...scope, seesEveryProject: true },
      { id: 'p', visibility: 'PRIVATE', createdById: 'x' },
    ),
  );
}

function checkSignatures(): void {
  check(
    'sig visible: admin = workspace',
    eq(signatureVisibleWhere({ userId: 'u', workspaceId: 'w', workspaceRole: 'OWNER' }), {
      workspaceId: 'w',
    }),
  );
  const m = signatureVisibleWhere({ userId: 'u', workspaceId: 'w', workspaceRole: 'MEMBER' }) as {
    workspaceId: string;
    OR: Array<Record<string, unknown>>;
  };
  check('sig visible: member pinned to workspace', m.workspaceId === 'w');
  check('sig visible: requester branch', eq(m.OR[0], { createdById: 'u' }));
  const doc = (m.OR[1] as { document: Record<string, unknown> }).document;
  check('sig visible: doc branch skips deleted docs', doc['deletedAt'] === null);
  check('sig visible: doc branch pinned to workspace', doc['workspaceId'] === 'w');

  const rel = clientSignatureRelationWhere('c1', ['A@x.com', 'a@x.com', 'b@y.com']) as {
    status: unknown;
    OR: Array<Record<string, unknown>>;
  };
  check('sig relation: drafts excluded', eq(rel.status, { not: 'DRAFT' }));
  check(
    'sig relation: signer emails lowercased and deduped',
    eq(rel.OR[2], { signers: { some: { email: { in: ['a@x.com', 'b@y.com'] } } } }),
  );
  const none = clientSignatureRelationWhere('c1', []) as { OR: unknown[] };
  check('sig relation: no signer branch without contacts', none.OR.length === 2);
}

function checkFinanceWhere(): void {
  check(
    'contracts: own or client-less on live project',
    eq(clientContractWhere('c'), {
      OR: [{ clientId: 'c' }, { clientId: null, project: { clientId: 'c', deletedAt: null } }],
    }),
  );
  const p = clientPaymentWhere('c') as { OR: unknown[] };
  check('payments: invoice-only branch present', eq(p.OR[0], { invoice: { clientId: 'c' } }));
  check(
    'payments: contract branch reuses contract rule',
    eq(p.OR[1], { contract: clientContractWhere('c') }),
  );
}

function checkBilling(): void {
  const now = new Date('2026-10-06T00:00:00Z');
  const past = new Date('2026-09-01T00:00:00Z');
  const future = new Date('2026-12-01T00:00:00Z');
  const r = summarizeClientBilling(
    {
      invoices: [
        { currency: 'USD', status: 'DRAFT', total: '999', amountPaid: '0', dueAt: future },
        { currency: 'USD', status: 'CANCELLED', total: '50', amountPaid: '0', dueAt: future },
        { currency: 'USD', status: 'SENT', total: '100', amountPaid: '0', dueAt: future },
        {
          currency: 'USD',
          status: 'PARTIALLY_PAID',
          total: '200',
          amountPaid: '50.5',
          dueAt: past,
        },
        { currency: 'USD', status: 'PAID', total: '300', amountPaid: '300', dueAt: past },
        // Overpaid open invoice: must not reduce another invoice's balance.
        { currency: 'USD', status: 'SENT', total: '10', amountPaid: '15', dueAt: future },
        { currency: 'PKR', status: 'OVERDUE', total: '1000', amountPaid: '0', dueAt: past },
      ],
      contracts: [
        { currency: 'USD', status: 'ACTIVE', totalValue: '1000', amountPaid: '400' },
        { currency: 'USD', status: 'COMPLETED', totalValue: '500', amountPaid: '600' },
        { currency: 'USD', status: 'DRAFT', totalValue: '7777', amountPaid: '0' },
        { currency: 'EUR', status: 'CANCELLED', totalValue: '5', amountPaid: '0' },
      ],
      payments: [
        { currency: 'USD', amount: '765.5', count: 4 },
        { currency: 'EUR', amount: null, count: 0 },
      ],
    },
    now,
  );
  const usd = r.byCurrency.find((c) => c.currency === 'USD');
  const pkr = r.byCurrency.find((c) => c.currency === 'PKR');
  check(
    'billing: currencies sorted and never mixed',
    eq(
      r.byCurrency.map((c) => c.currency),
      ['EUR', 'PKR', 'USD'],
    ),
  );
  check('billing: invoiced excludes draft/cancelled', usd?.invoiced === '610.00', usd?.invoiced);
  check('billing: invoice paid', usd?.invoicePaid === '365.50', usd?.invoicePaid);
  check(
    'billing: invoice outstanding clamps per row',
    usd?.invoiceOutstanding === '249.50',
    usd?.invoiceOutstanding,
  );
  check(
    'billing: contracted active+completed only',
    usd?.contracted === '1500.00',
    usd?.contracted,
  );
  check(
    'billing: contract outstanding clamps per row',
    usd?.contractOutstanding === '600.00',
    usd?.contractOutstanding,
  );
  check('billing: received', usd?.received === '765.50', usd?.received);
  check('billing: PKR outstanding', pkr?.invoiceOutstanding === '1000.00', pkr?.invoiceOutstanding);
  check(
    'billing: counts',
    eq(r.counts, { invoices: 5, openInvoices: 4, overdueInvoices: 2, contracts: 2, payments: 4 }),
    JSON.stringify(r.counts),
  );
  check(
    'billing: output parses',
    clientBillingSummarySchema.safeParse({ clientId: 'ckclient0000000000000000', ...r }).success,
  );
}

function checkCursorAndFeed(): void {
  const c: FeedCursor = {
    at: new Date('2026-10-01T10:00:00.123Z'),
    source: 'project',
    rowId: 'ckabc',
  };
  const enc = encodeCursor(c);
  check('cursor: url-safe', /^[A-Za-z0-9_-]+$/.test(enc), enc);
  const dec = decodeCursor(enc);
  check(
    'cursor: round-trips',
    !!dec &&
      dec.at.getTime() === c.at.getTime() &&
      dec.source === c.source &&
      dec.rowId === c.rowId,
  );
  check('cursor: absent is null', decodeCursor(undefined) === null);
  for (const bad of [
    'not-json',
    Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from('["x","a","b"]').toString('base64url'),
  ]) {
    let threw = false;
    try {
      decodeCursor(bad);
    } catch (err) {
      threw = err instanceof HttpException && err.getStatus() === 400;
    }
    check(`cursor: garbage refused with 400 (${bad.slice(0, 12)})`, threw);
  }

  check('keyset: no cursor no filter', eq(keysetWhere('a', 'createdAt', null), {}));
  check(
    'keyset: earlier source includes the tie',
    eq(keysetWhere('a', 'createdAt', c), { createdAt: { lte: c.at } }),
  );
  check(
    'keyset: later source excludes the tie',
    eq(keysetWhere('z', 'createdAt', c), { createdAt: { lt: c.at } }),
  );
  check(
    'keyset: same source breaks the tie on id',
    eq(keysetWhere('project', 'createdAt', c), {
      OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: 'ckabc' } }],
    }),
  );

  // Simulate several sources (some sharing timestamps) and page through them
  // the way the service does: each source applies the keyset in memory,
  // returns limit + 1, and mergeFeed builds the page.
  const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m));
  const tables: Record<string, Array<{ id: string; at: Date }>> = {
    project: [
      { id: 'p1', at: t(5) },
      { id: 'p2', at: t(5) },
      { id: 'p3', at: t(1) },
    ],
    audit: [
      { id: 'a1', at: t(5) },
      { id: 'a2', at: t(4) },
      { id: 'a3', at: t(4) },
      { id: 'a4', at: t(0) },
    ],
    invoice: [
      { id: 'i1', at: t(9) },
      { id: 'i2', at: t(5) },
    ],
  };
  const all: FeedEntry[] = Object.entries(tables).flatMap(([source, rows]) =>
    rows.map((r) =>
      feedEntry(source, r.id, r.at, {
        kind: 'PROJECT_CREATED',
        actor: null,
        title: r.id,
        detail: null,
        entity: null,
      }),
    ),
  );
  const expected = [...all].sort(
    (a, b) =>
      b.key.at.getTime() - a.key.at.getTime() ||
      (a.key.source > b.key.source
        ? -1
        : a.key.source < b.key.source
          ? 1
          : a.key.rowId > b.key.rowId
            ? -1
            : 1),
  );

  for (const limit of [1, 2, 3, 4, 50]) {
    const seen: string[] = [];
    let cursor: FeedCursor | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const sources = Object.keys(tables).map((source) =>
        all
          .filter((e) => e.key.source === source && isAfterCursor(e.key, cursor))
          .sort(
            (a, b) =>
              b.key.at.getTime() - a.key.at.getTime() || (a.key.rowId > b.key.rowId ? -1 : 1),
          )
          .slice(0, limit + 1),
      );
      const page = mergeFeed(sources, limit, cursor);
      check(`feed: page parses (limit ${limit})`, clientActivityListSchema.safeParse(page).success);
      check(`feed: page within limit (limit ${limit})`, page.items.length <= limit);
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = decodeCursor(page.nextCursor);
    }
    check(
      `feed: every item once, newest first (limit ${limit})`,
      eq(
        seen,
        expected.map((e) => e.item.id),
      ),
      seen.join(','),
    );
  }
}

function checkCustomFields(): void {
  const opts = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];
  check('cf: null always clears', customFieldValueProblem('SELECT', opts, null) === null);
  check('cf: select in options', customFieldValueProblem('SELECT', opts, 'a') === null);
  check(
    'cf: select outside options refused',
    customFieldValueProblem('SELECT', opts, 'z') !== null,
  );
  check('cf: multi in options', customFieldValueProblem('MULTI_SELECT', opts, ['a', 'b']) === null);
  check(
    'cf: multi outside options refused',
    customFieldValueProblem('MULTI_SELECT', opts, ['a', 'z']) !== null,
  );
  check(
    'cf: select without options refused',
    customFieldValueProblem('SELECT', null, 'a') !== null,
  );
  check('cf: number', customFieldValueProblem('NUMBER', null, 3) === null);
  check('cf: NaN refused', customFieldValueProblem('NUMBER', null, Number.NaN) !== null);
  check('cf: date parses', customFieldValueProblem('DATE', null, '2026-10-06') === null);
  check('cf: bad date refused', customFieldValueProblem('DATE', null, 'soon') !== null);
  check('cf: checkbox type', customFieldValueProblem('CHECKBOX', null, 'yes') !== null);
  check('cf: user is a string', customFieldValueProblem('USER', null, 42) !== null);
  check('cf: generic routes serve PROJECT', isGenericValueScope('PROJECT'));
  check('cf: generic routes serve TASK', isGenericValueScope('TASK'));
  check('cf: generic routes refuse CLIENT', !isGenericValueScope('CLIENT'));
  check('cf: generic routes refuse LEAD', !isGenericValueScope('LEAD'));
}

function main(): void {
  checkVisibility();
  checkDocuments();
  checkSignatures();
  checkFinanceWhere();
  checkBilling();
  checkCursorAndFeed();
  checkCustomFields();
}

try {
  main();
  if (failures > 0) {
    console.error(`Client hub checks: ${failures} failed.`);
    process.exit(1);
  }
  console.log('Client hub checks: all passed.');
  process.exit(0);
} catch (err) {
  console.error('Client hub checks crashed:', err);
  process.exit(1);
}
