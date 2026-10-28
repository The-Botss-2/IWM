'use client';

import { Download } from 'lucide-react';
import { use } from 'react';
import type { PortalInvoiceDetail } from '@botss/shared-types';

import { formatDate, formatPercent, formatQuantity, joinParts } from '@/components/portal/format';
import { InvoiceStatusBadge } from '@/components/portal/portal-badges';
import { usePortalClient } from '@/components/portal/portal-context';
import { PortalBackLink, PortalPageHeader } from '@/components/portal/portal-page-header';
import { BillingUnavailable, PortalUnavailable } from '@/components/portal/portal-states';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  portalErrorStatus,
  portalHref,
  usePortalInvoice,
  usePortalInvoiceBreakdown,
  usePortalInvoicePdf,
} from '@/hooks/use-portal';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

const TH = 'px-4 py-3 font-medium sm:px-6';
const TD = 'px-4 py-3 sm:px-6';

export default function PortalInvoicePage({
  params,
}: {
  params: Promise<{ clientId: string; invoiceId: string }>;
}) {
  const { clientId, invoiceId } = use(params);
  const client = usePortalClient(clientId);
  const canSeeBilling = client?.canSeeBilling ?? false;
  const invoice = usePortalInvoice(clientId, invoiceId, canSeeBilling);
  const breakdown = usePortalInvoiceBreakdown(invoice.data);
  const pdf = usePortalInvoicePdf(clientId);
  const back = { href: portalHref(clientId, 'billing'), label: 'Billing' };

  if (!client) return null;

  if (!canSeeBilling || portalErrorStatus(invoice.error) === 403) {
    return (
      <div className="space-y-6">
        <PortalBackLink href={back.href} label={back.label} />
        <BillingUnavailable />
      </div>
    );
  }

  if (invoice.isLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (invoice.isError || !invoice.data || !breakdown) {
    if (portalErrorStatus(invoice.error) === 404) {
      return (
        <PortalUnavailable
          title="This invoice isn't available"
          description="It may have been withdrawn. Your billing page lists every invoice you can see."
          href={back.href}
          linkLabel="Back to billing"
        />
      );
    }
    return (
      <div className="space-y-6">
        <PortalPageHeader back={back} title="Invoice" />
        <QueryError message="Couldn't load this invoice." onRetry={() => void invoice.refetch()} />
      </div>
    );
  }

  const inv = invoice.data;
  const context = joinParts([
    inv.projectName ? `Project: ${inv.projectName}` : null,
    inv.contractTitle ? `Contract: ${inv.contractTitle}` : null,
  ]);

  return (
    <div className="space-y-6">
      <PortalPageHeader
        back={back}
        title={`Invoice ${inv.number}`}
        meta={
          <>
            <InvoiceStatusBadge status={inv.status} />
            <span>Issued {formatDate(inv.issuedAt)}</span>
            <span>Due {formatDate(inv.dueAt)}</span>
          </>
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => pdf.mutate({ id: inv.id, number: inv.number })}
            disabled={pdf.isPending}
          >
            {pdf.isPending ? (
              <span aria-hidden className="spinner-gradient h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {pdf.isPending ? 'Preparing PDF' : 'Download PDF'}
          </Button>
        }
      />

      <article aria-label={`Invoice ${inv.number}`} className="card overflow-hidden">
        {context ? (
          <p className="border-line text-ink-muted border-b px-4 py-3 text-sm sm:px-6">{context}</p>
        ) : null}

        <LineItems
          invoice={inv}
          showTaxRate={breakdown.showTaxRate}
          discounted={breakdown.discountedLineIds}
        />

        <div className="border-line flex flex-col gap-6 border-t px-4 py-5 sm:px-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-4 lg:max-w-md">
            {inv.notes ? <TextBlock title="Notes" text={inv.notes} /> : null}
            {inv.terms ? <TextBlock title="Terms" text={inv.terms} /> : null}
          </div>
          <dl className="w-full space-y-2 text-sm lg:max-w-xs">
            {breakdown.totals.map((row) => (
              <div
                key={row.key}
                className={cn(
                  'flex items-baseline justify-between gap-4',
                  row.strong
                    ? 'border-line text-ink border-t pt-2 font-semibold'
                    : 'text-ink-muted',
                  row.key === 'balance' && 'text-base',
                )}
              >
                <dt>{row.label}</dt>
                <dd className="tabular-nums">{formatCurrency(row.amount, inv.currency)}</dd>
              </div>
            ))}
          </dl>
        </div>

        {inv.footer ? (
          <p className="border-line text-ink-muted whitespace-pre-wrap border-t px-4 py-4 text-xs sm:px-6">
            {inv.footer}
          </p>
        ) : null}
      </article>
    </div>
  );
}

function LineItems({
  invoice,
  showTaxRate,
  discounted,
}: {
  invoice: PortalInvoiceDetail;
  showTaxRate: boolean;
  discounted: ReadonlySet<string>;
}) {
  return (
    // Scrolls sideways on a phone instead of squeezing the columns.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-line text-ink-muted border-b text-left text-xs">
            <th scope="col" className={cn(TH, 'w-12')}>
              #
            </th>
            <th scope="col" className={TH}>
              Description
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              Qty
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              Unit price
            </th>
            {showTaxRate ? (
              <th scope="col" className={cn(TH, 'text-right')}>
                Tax
              </th>
            ) : null}
            <th scope="col" className={cn(TH, 'text-right')}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.length === 0 ? (
            <tr>
              <td colSpan={showTaxRate ? 6 : 5} className={cn(TD, 'text-ink-muted text-center')}>
                No line items.
              </td>
            </tr>
          ) : (
            invoice.lineItems.map((line, i) => (
              <tr key={line.id} className="border-line border-b align-top last:border-0">
                <td className={cn(TD, 'text-ink-muted tabular-nums')}>{i + 1}</td>
                <td className={cn(TD, 'text-ink')}>
                  <span className="whitespace-pre-wrap">{line.description}</span>
                  {discounted.has(line.id) ? (
                    <span className="text-ink-muted">
                      {' '}
                      ({formatPercent(line.discountRate)} off)
                    </span>
                  ) : null}
                </td>
                <td className={cn(TD, 'text-ink whitespace-nowrap text-right')}>
                  {formatQuantity(line.quantity)}
                </td>
                <td className={cn(TD, 'text-ink whitespace-nowrap text-right')}>
                  {formatCurrency(line.unitPrice, invoice.currency)}
                </td>
                {showTaxRate ? (
                  <td className={cn(TD, 'text-ink-muted whitespace-nowrap text-right')}>
                    {formatPercent(line.taxRate)}
                  </td>
                ) : null}
                <td className={cn(TD, 'text-ink whitespace-nowrap text-right font-medium')}>
                  {formatCurrency(line.amount, invoice.currency)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-ink text-sm font-medium">{title}</h2>
      <p className="text-ink-muted mt-1 whitespace-pre-wrap text-sm">{text}</p>
    </div>
  );
}
