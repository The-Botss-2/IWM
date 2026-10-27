'use client';

import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ClientBillingCurrency, ClientBillingSummary } from '@botss/shared-types';

import { ContractFormDialog } from '@/components/financials/contract-form-dialog';
import { ContractList } from '@/components/financials/contract-list';
import { InvoiceList } from '@/components/financials/invoice-list';
import { PaymentList } from '@/components/financials/payment-list';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useClientBilling } from '@/hooks/use-client-billing';
import { useContracts, usePayments } from '@/hooks/use-finance';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

type BillingSubTab = 'invoices' | 'contracts' | 'payments';

/**
 * Money for one client (finance roles only): per-currency totals on top,
 * then the client's invoices, contracts and payments. Currencies are never
 * added together.
 */
export function ClientBillingTab({ clientId }: { clientId: string }) {
  const summary = useClientBilling(clientId);
  const [sub, setSub] = useState<BillingSubTab>('invoices');

  return (
    <div className="space-y-6">
      <section aria-labelledby="client-billing-heading" className="space-y-3">
        <h2 id="client-billing-heading" className="text-base font-semibold text-ink">
          Billing
        </h2>
        {summary.isLoading ? (
          <Skeleton className="h-36 w-full" />
        ) : summary.isError || !summary.data ? (
          <QueryError
            message="Couldn't load billing totals."
            onRetry={() => void summary.refetch()}
          />
        ) : (
          <BillingSummary summary={summary.data} />
        )}
      </section>

      <Tabs value={sub} onValueChange={(v) => setSub(v as BillingSubTab)}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="contracts">Contracts</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
        </TabsList>
        <div className="pt-4">
          <TabsContent value="invoices">
            <InvoiceList clientId={clientId} />
          </TabsContent>
          <TabsContent value="contracts">
            <ClientContracts clientId={clientId} />
          </TabsContent>
          <TabsContent value="payments">
            <ClientPayments clientId={clientId} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function BillingSummary({ summary }: { summary: ClientBillingSummary }) {
  const { counts } = summary;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        {plural(counts.invoices, 'invoice', 'invoices')}
        {counts.openInvoices > 0 ? `, ${counts.openInvoices} open` : ''}
        {counts.overdueInvoices > 0 ? (
          <span className="text-state-error">, {counts.overdueInvoices} overdue</span>
        ) : null}
        {' · '}
        {plural(counts.contracts, 'contract', 'contracts')}
        {' · '}
        {plural(counts.payments, 'payment', 'payments')}
      </p>
      {summary.byCurrency.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-white p-6 text-center text-sm text-ink-muted">
          Nothing billed or received yet.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {summary.byCurrency.map((row) => (
            <CurrencyCard key={row.currency} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function CurrencyCard({ row }: { row: ClientBillingCurrency }) {
  const money = (v: string) => formatCurrency(v, row.currency);
  return (
    <section
      aria-label={`${row.currency} totals`}
      className="rounded-lg border border-line bg-white p-4"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        {row.currency}
      </h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <Group title="Invoices">
          <Figure label="Invoiced" value={money(row.invoiced)} />
          <Figure label="Paid" value={money(row.invoicePaid)} />
          <Figure
            label="Outstanding"
            value={money(row.invoiceOutstanding)}
            alert={Number(row.invoiceOutstanding) > 0}
          />
        </Group>
        <Group title="Contracts">
          <Figure label="Contracted" value={money(row.contracted)} />
          <Figure
            label="Outstanding"
            value={money(row.contractOutstanding)}
            alert={Number(row.contractOutstanding) > 0}
          />
        </Group>
        <Group title="Payments">
          <Figure label="Received" value={money(row.received)} strong />
        </Group>
      </div>
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-ink">{title}</p>
      <dl className="mt-1.5 space-y-1">{children}</dl>
    </div>
  );
}

function Figure({
  label,
  value,
  alert,
  strong,
}: {
  label: string;
  value: string;
  alert?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          strong && 'font-semibold text-ink',
          alert && 'font-medium text-brand-orange',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ClientContracts({ clientId }: { clientId: string }) {
  const contracts = useContracts({ clientId, pageSize: 100 });
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          New contract
        </Button>
      </div>
      {contracts.isError ? (
        <QueryError
          message="Couldn't load contracts."
          onRetry={() => void contracts.refetch()}
        />
      ) : (
        <ContractList items={contracts.data?.items ?? []} loading={contracts.isLoading} />
      )}
      <ContractFormDialog
        open={creating}
        onOpenChange={setCreating}
        defaultClientId={clientId}
      />
    </div>
  );
}

function ClientPayments({ clientId }: { clientId: string }) {
  const payments = usePayments({ clientId, pageSize: 100 });
  if (payments.isError) {
    return (
      <QueryError
        message="Couldn't load payments."
        onRetry={() => void payments.refetch()}
      />
    );
  }
  return (
    <PaymentList
      items={payments.data?.items ?? []}
      loading={payments.isLoading}
    />
  );
}
