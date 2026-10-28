'use client';

import { FileText, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { InvoiceStatus } from '@botss/shared-types';

import { InvoiceStatusMenu } from '@/components/financials/invoice-status-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageLoader } from '@/components/ui/loader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useInvoices } from '@/hooks/use-invoices';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

const ALL = '__all__';

const STATUS_OPTIONS: InvoiceStatus[] = [
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'REFUNDED',
];

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  DRAFT: 'bg-bg-subtle text-ink-muted',
  SENT: 'bg-brand-50 text-brand-700',
  PARTIALLY_PAID: 'bg-amber-50 text-amber-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  OVERDUE: 'bg-red-50 text-red-700',
  CANCELLED: 'bg-bg-subtle text-ink-disabled line-through',
  REFUNDED: 'bg-bg-subtle text-ink-disabled',
};

function statusLabel(status: InvoiceStatus): string {
  const s = status.toLowerCase().replace('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The Invoices sub-tab of Financials. With `clientId` it lists only that
 * client's invoices (the client page's Billing tab): the client column is
 * dropped and "New invoice" starts one for that client.
 */
export function InvoiceList({ clientId }: { clientId?: string } = {}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const q = useDebouncedValue(search, 300);
  const invoices = useInvoices({
    ...(clientId ? { clientId } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(status !== ALL ? { status: status as InvoiceStatus } : {}),
  });
  const items = invoices.data?.items ?? [];
  const newHref = clientId
    ? `/financials/invoices/new?clientId=${encodeURIComponent(clientId)}`
    : '/financials/invoices/new';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-64"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={clientId ? 'Search number' : 'Search number or client'}
          aria-label="Search invoices"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex gap-2">
          {clientId ? null : (
            <Button asChild variant="ghost">
              <Link href="/settings/invoicing">Invoice settings</Link>
            </Button>
          )}
          <Button asChild>
            <Link href={newHref}>
              <Plus className="h-4 w-4" /> New invoice
            </Link>
          </Button>
        </div>
      </div>

      {invoices.isLoading ? (
        <PageLoader label="Loading invoices" className="min-h-[12rem]" />
      ) : invoices.isError ? (
        <div className="border-line bg-bg-surface text-ink-muted rounded-md border p-6 text-sm">
          Couldn&apos;t load invoices.{' '}
          <button type="button" className="underline" onClick={() => void invoices.refetch()}>
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="border-line bg-bg-surface flex flex-col items-center gap-3 rounded-md border border-dashed p-10 text-center">
          <FileText className="text-ink-disabled h-8 w-8" aria-hidden />
          <p className="text-ink-muted text-sm">
            {q || status !== ALL ? 'No invoices match these filters.' : 'No invoices yet.'}
          </p>
          {!q && status === ALL ? (
            <Button asChild size="sm">
              <Link href={newHref}>
                {clientId ? 'Create an invoice for this client' : 'Create your first invoice'}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="border-line bg-bg-surface overflow-x-auto rounded-md border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-line text-ink-muted border-b text-left text-xs">
                <th className="px-4 py-2 font-medium">Number</th>
                {clientId ? null : <th className="px-4 py-2 font-medium">Client</th>}
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => {
                const balance = Number(inv.total) - Number(inv.amountPaid);
                return (
                  <tr
                    key={inv.id}
                    className="border-line hover:bg-bg-subtle border-b last:border-0"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/financials/invoices/${inv.id}`}
                        className="text-ink font-medium hover:underline"
                      >
                        {inv.number}
                      </Link>
                    </td>
                    {clientId ? null : (
                      <td className="text-ink-muted px-4 py-2">{inv.client.name}</td>
                    )}
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          'inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_STYLES[inv.status],
                        )}
                      >
                        {statusLabel(inv.status)}
                      </span>
                    </td>
                    <td className="text-ink-muted px-4 py-2">
                      {new Date(inv.dueAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatCurrency(inv.total, inv.currency)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatCurrency(balance.toFixed(2), inv.currency)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <InvoiceStatusMenu invoice={inv} size="sm" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
