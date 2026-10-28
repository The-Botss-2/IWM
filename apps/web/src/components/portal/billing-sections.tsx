'use client';

import { Banknote, FileSignature, Receipt } from 'lucide-react';
import Link from 'next/link';
import type { PortalContract } from '@botss/shared-types';

import {
  dateRangeLabel,
  formatDate,
  joinParts,
  milestoneDateLabel,
  paymentAppliedTo,
} from '@/components/portal/format';
import {
  billingModelLabel,
  ContractStatusBadge,
  InvoiceStatusBadge,
  MilestoneStatusBadge,
  PaymentStatusBadge,
} from '@/components/portal/portal-badges';
import { BillingUnavailable, PortalEmpty } from '@/components/portal/portal-states';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  invoiceAmountDue,
  invoiceShowsBalance,
  portalErrorStatus,
  portalInvoiceHref,
  usePortalContracts,
  usePortalInvoices,
  usePortalPayments,
} from '@/hooks/use-portal';
import { formatCurrency } from '@/lib/money';

/*
 * The three billing tabs. Each loads only while its tab is open (Radix
 * unmounts hidden tab panels). The page shows these to the main contact
 * only; a 403 from the API still lands on the same message, in case the
 * person's role changed since the portal loaded.
 */

const TH = 'px-4 py-3 font-medium';
const TD = 'px-4 py-3';
const ROW_LINK =
  'block px-4 py-3.5 transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-purple/50';

function SectionSkeleton() {
  return (
    <div className="card space-y-3 p-5" aria-busy="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
}

function SectionError({
  error,
  onRetry,
  what,
}: {
  error: unknown;
  onRetry: () => void;
  what: string;
}) {
  if (portalErrorStatus(error) === 403) return <BillingUnavailable />;
  return <QueryError message={`Couldn't load ${what.toLowerCase()}.`} onRetry={onRetry} />;
}

export function PortalInvoicesSection({ clientId }: { clientId: string }) {
  const invoices = usePortalInvoices(clientId, true);
  if (invoices.isLoading) return <SectionSkeleton />;
  if (invoices.isError || !invoices.data) {
    return (
      <SectionError
        error={invoices.error}
        what="Invoices"
        onRetry={() => void invoices.refetch()}
      />
    );
  }
  const items = invoices.data.items;
  if (items.length === 0) {
    return (
      <PortalEmpty
        icon={Receipt}
        title="No invoices yet"
        description="Invoices sent to your company appear here, with a PDF copy of each."
      />
    );
  }

  return (
    <>
      {/* Phones: one tappable row per invoice. */}
      <ul className="card divide-line divide-y overflow-hidden sm:hidden">
        {items.map((inv) => {
          const due = invoiceAmountDue(inv);
          return (
            <li key={inv.id}>
              <Link href={portalInvoiceHref(clientId, inv.id)} className={ROW_LINK}>
                <span className="flex items-center justify-between gap-3">
                  <span className="text-ink truncate text-sm font-medium">{inv.number}</span>
                  <InvoiceStatusBadge status={inv.status} />
                </span>
                <span className="text-ink-muted mt-1.5 flex items-baseline justify-between gap-3 text-xs">
                  <span>Due {formatDate(inv.dueAt)}</span>
                  <span className="text-ink text-sm tabular-nums">
                    {due
                      ? `${formatCurrency(due, inv.currency)} due`
                      : formatCurrency(inv.total, inv.currency)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Wider screens: the full table. */}
      <div className="card hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-line text-ink-muted border-b text-left text-xs">
              <th scope="col" className={TH}>
                Invoice
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Issued
              </th>
              <th scope="col" className={TH}>
                Due
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Total
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <tr key={inv.id} className="border-line border-b last:border-0">
                <td className={TD}>
                  <Link
                    href={portalInvoiceHref(clientId, inv.id)}
                    className="text-ink focus-visible:ring-brand-purple/50 rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-2"
                  >
                    {inv.number}
                  </Link>
                  {inv.projectName ? (
                    <span className="text-ink-muted block text-xs">{inv.projectName}</span>
                  ) : null}
                </td>
                <td className={TD}>
                  <InvoiceStatusBadge status={inv.status} />
                </td>
                <td className={`${TD} text-ink-muted whitespace-nowrap`}>
                  {formatDate(inv.issuedAt)}
                </td>
                <td className={`${TD} text-ink-muted whitespace-nowrap`}>
                  {formatDate(inv.dueAt)}
                </td>
                <td className={`${TD} whitespace-nowrap text-right`}>
                  {formatCurrency(inv.total, inv.currency)}
                </td>
                <td className={`${TD} text-ink whitespace-nowrap text-right font-medium`}>
                  {invoiceShowsBalance(inv.status)
                    ? formatCurrency(inv.balance, inv.currency)
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function PortalContractsSection({ clientId }: { clientId: string }) {
  const contracts = usePortalContracts(clientId, true);
  if (contracts.isLoading) return <SectionSkeleton />;
  if (contracts.isError || !contracts.data) {
    return (
      <SectionError
        error={contracts.error}
        what="Contracts"
        onRetry={() => void contracts.refetch()}
      />
    );
  }
  const items = contracts.data.items;
  if (items.length === 0) {
    return (
      <PortalEmpty
        icon={FileSignature}
        title="No contracts yet"
        description="Contracts with your company appear here, with what has been paid so far."
      />
    );
  }
  return (
    <ul className="space-y-4">
      {items.map((contract) => (
        <li key={contract.id}>
          <ContractCard contract={contract} />
        </li>
      ))}
    </ul>
  );
}

function ContractCard({ contract: c }: { contract: PortalContract }) {
  const headingId = `contract-${c.id}`;
  const meta = joinParts([
    billingModelLabel(c.billingModel),
    c.projectName,
    dateRangeLabel(c.startDate, c.endDate),
  ]);
  return (
    <article aria-labelledby={headingId} className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="text-ink text-base font-semibold">
            {c.title}
          </h2>
          {meta ? <p className="text-ink-muted text-sm">{meta}</p> : null}
        </div>
        <ContractStatusBadge status={c.status} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="text-ink-muted text-xs">Total value</dt>
          <dd className="text-ink mt-0.5 text-sm font-semibold tabular-nums">
            {formatCurrency(c.totalValue, c.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted text-xs">Paid</dt>
          <dd className="text-ink mt-0.5 text-sm font-semibold tabular-nums">
            {formatCurrency(c.amountPaid, c.currency)}
          </dd>
        </div>
        {/* A cancelled contract is not owed, whatever the arithmetic says. */}
        {c.status !== 'CANCELLED' ? (
          <div>
            <dt className="text-ink-muted text-xs">Balance</dt>
            <dd className="text-ink mt-0.5 text-sm font-semibold tabular-nums">
              {formatCurrency(c.balance, c.currency)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-ink-muted text-xs">Payment</dt>
          <dd className="mt-1">
            <PaymentStatusBadge status={c.paymentStatus} />
          </dd>
        </div>
      </dl>

      {c.milestones.length > 0 ? (
        <div className="border-line mt-5 border-t pt-4">
          <h3 className="text-ink text-sm font-medium">Milestones</h3>
          <ul className="divide-line mt-1 divide-y">
            {c.milestones.map((m) => {
              const dates = milestoneDateLabel(m);
              return (
                <li
                  key={m.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-ink text-sm">{m.title}</p>
                    {dates ? <p className="text-ink-muted text-xs">{dates}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <MilestoneStatusBadge status={m.status} />
                    <PaymentStatusBadge status={m.paymentStatus} />
                  </div>
                  <div className="text-ink text-sm tabular-nums sm:w-36 sm:text-right">
                    {formatCurrency(m.amount, c.currency)}
                    {m.paymentStatus === 'PARTIAL' ? (
                      <span className="text-ink-muted block text-xs">
                        {formatCurrency(m.amountPaid, c.currency)} paid
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

export function PortalPaymentsSection({ clientId }: { clientId: string }) {
  const payments = usePortalPayments(clientId, true);
  if (payments.isLoading) return <SectionSkeleton />;
  if (payments.isError || !payments.data) {
    return (
      <SectionError
        error={payments.error}
        what="Payments"
        onRetry={() => void payments.refetch()}
      />
    );
  }
  const items = payments.data.items;
  if (items.length === 0) {
    return (
      <PortalEmpty
        icon={Banknote}
        title="No payments yet"
        description="Payments received from your company appear here."
      />
    );
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-line text-ink-muted border-b text-left text-xs">
            <th scope="col" className={TH}>
              Date
            </th>
            <th scope="col" className={TH}>
              Paid toward
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} className="border-line border-b last:border-0">
              <td className={`${TD} text-ink-muted whitespace-nowrap`}>{formatDate(p.paidAt)}</td>
              <td className={`${TD} text-ink`}>{paymentAppliedTo(p)}</td>
              <td className={`${TD} text-ink whitespace-nowrap text-right font-medium`}>
                {formatCurrency(p.amount, p.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
