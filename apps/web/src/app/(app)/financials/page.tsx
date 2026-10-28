'use client';

import { Plus, UserPlus } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { ContractStatus, PaymentStatus } from '@botss/shared-types';

import { ContractFormDialog } from '@/components/financials/contract-form-dialog';
import { ContractList } from '@/components/financials/contract-list';
import { ExpenseFormDialog, ExpenseList } from '@/components/financials/expense-list';
import {
  CONTRACT_STATUS_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  contractStatusLabel,
  paymentStatusLabel,
} from '@/components/financials/finance-badges';
import { InvoiceList } from '@/components/financials/invoice-list';
import { FinancialsTabs, useFinanceTab } from '@/components/financials/financials-tabs';
import { PaymentList } from '@/components/financials/payment-list';
import { PaymentSourceManager } from '@/components/financials/payment-source-manager';
import { PayrollPanel } from '@/components/financials/payroll/payroll-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useContracts, useExpenses, useFinanceSummary, usePayments } from '@/hooks/use-finance';
import { useRequireSystemRole } from '@/hooks/use-require-system-role';

const ALL = '__all__';

/**
 * The Financials tab.
 *
 * Guarded client-side for UX only - the server revokes the Contract / Payment
 * / Expense CASL subjects for anyone without `hasFinanceAccess`, so a direct
 * API call from a non-finance user 403s regardless of what this renders.
 */
// FinanceOverview's charts pull in recharts; load it on demand. The fallback
// mirrors FinanceOverview's own loading skeleton.
const FinanceOverview = dynamic(
  () =>
    import('@/components/financials/finance-overview').then((m) => ({
      default: m.FinanceOverview,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    ),
  },
);

export default function FinancialsPage() {
  const { checking, allowed } = useRequireSystemRole(['ADMIN', 'SUPER_ADMIN', 'FINANCE']);
  const { tab, setTab } = useFinanceTab();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [status, setStatus] = useState<string>(ALL);
  const [paymentStatus, setPaymentStatus] = useState<string>(ALL);
  const [creating, setCreating] = useState(false);
  const [addingExpense, setAddingExpense] = useState(false);
  const [addingPayrollPeople, setAddingPayrollPeople] = useState(false);

  // The overview reports on the current month; contracts and outstanding are
  // point-in-time and ignore the range.
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    return { from, to };
  }, []);

  // Payroll needs the base currency too, to ask for an exchange rate when
  // the organization does not report in PKR.
  const summary = useFinanceSummary(range, allowed && (tab === 'overview' || tab === 'payroll'));

  const contracts = useContracts({
    ...(debouncedSearch ? { q: debouncedSearch } : {}),
    ...(status !== ALL ? { status: status as ContractStatus } : {}),
    ...(paymentStatus !== ALL ? { paymentStatus: paymentStatus as PaymentStatus } : {}),
    pageSize: 100,
  });
  const payments = usePayments({ pageSize: 100 });
  const expenses = useExpenses({ pageSize: 100 });

  if (checking || !allowed) {
    return (
      <div className="text-ink-muted p-6 text-sm">
        {checking ? 'Checking access…' : 'Redirecting…'}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Financials</h1>
          <p className="text-ink-muted text-sm">
            Contracts, what has been paid, and where the money came from.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'expenses' ? (
            <Button onClick={() => setAddingExpense(true)}>
              <Plus className="h-4 w-4" /> Record expense
            </Button>
          ) : tab === 'payroll' ? (
            <Button onClick={() => setAddingPayrollPeople(true)}>
              <UserPlus className="h-4 w-4" /> Add people
            </Button>
          ) : (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New contract
            </Button>
          )}
        </div>
      </header>

      <FinancialsTabs tab={tab} onChange={setTab} />

      {tab === 'overview' ? (
        <FinanceOverview summary={summary.data} loading={summary.isLoading} />
      ) : null}

      {tab === 'contracts' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-64"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contracts…"
              aria-label="Search contracts"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-fit min-w-[10rem]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {CONTRACT_STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {contractStatusLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={paymentStatus} onValueChange={setPaymentStatus}>
              <SelectTrigger className="w-fit min-w-[10rem]">
                <SelectValue placeholder="Payment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any payment state</SelectItem>
                {PAYMENT_STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {paymentStatusLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {search || status !== ALL || paymentStatus !== ALL ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setStatus(ALL);
                  setPaymentStatus(ALL);
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
          <ContractList items={contracts.data?.items ?? []} loading={contracts.isLoading} />
        </div>
      ) : null}

      {tab === 'payments' ? (
        <PaymentList items={payments.data?.items ?? []} loading={payments.isLoading} />
      ) : null}

      {tab === 'expenses' ? (
        <ExpenseList items={expenses.data?.items ?? []} loading={expenses.isLoading} />
      ) : null}

      {tab === 'payroll' ? (
        <PayrollPanel
          addOpen={addingPayrollPeople}
          onAddOpenChange={setAddingPayrollPeople}
          // Null while loading (mark-paid waits for it). If the summary
          // fails, fall back to PKR and let the server ask for a rate.
          baseCurrency={summary.isError ? 'PKR' : (summary.data?.baseCurrency ?? null)}
        />
      ) : null}

      {tab === 'invoices' ? <InvoiceList /> : null}

      {tab === 'sources' ? <PaymentSourceManager /> : null}

      <ContractFormDialog open={creating} onOpenChange={setCreating} />
      <ExpenseFormDialog open={addingExpense} onOpenChange={setAddingExpense} />
    </div>
  );
}
