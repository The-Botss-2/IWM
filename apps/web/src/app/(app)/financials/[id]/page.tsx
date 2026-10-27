'use client';

import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { use, useCallback, useState } from 'react';

import { ContractFormDialog } from '@/components/financials/contract-form-dialog';
import { ExpenseFormDialog, ExpenseList } from '@/components/financials/expense-list';
import {
  ContractStatusBadge,
  PaymentStatusBadge,
  billingModelLabel,
} from '@/components/financials/finance-badges';
import {
  type ContractTab,
  ContractTabs,
} from '@/components/financials/financials-tabs';
import { MilestoneTable } from '@/components/financials/milestone-table';
import { PaymentFormDialog } from '@/components/financials/payment-form-dialog';
import { PaymentList } from '@/components/financials/payment-list';
import { Button } from '@/components/ui/button';
import { ConfirmByTypingDialog } from '@/components/ui/confirm-dialog';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useContract,
  useDeleteContract,
  useExpenses,
  usePayments,
} from '@/hooks/use-finance';
import { useRequireSystemRole } from '@/hooks/use-require-system-role';
import { useAbility } from '@/lib/ability';
import { formatCurrency } from '@/lib/money';

const TABS = ['overview', 'milestones', 'payments', 'expenses', 'invoices'] as const;
const DEFAULT_TAB: ContractTab = 'overview';

function parseTab(value: string | null | undefined): ContractTab {
  if (!value) return DEFAULT_TAB;
  return (TABS as readonly string[]).includes(value)
    ? (value as ContractTab)
    : DEFAULT_TAB;
}

export default function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { checking, allowed } = useRequireSystemRole([
    'ADMIN',
    'SUPER_ADMIN',
    'FINANCE',
  ]);

  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const setTab = useCallback(
    (next: ContractTab) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (next === DEFAULT_TAB) sp.delete('tab');
      else sp.set('tab', next);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [searchParams, router],
  );

  const contract = useContract(allowed ? id : '');
  const payments = usePayments(allowed ? { contractId: id, pageSize: 200 } : undefined);
  const expenses = useExpenses(allowed ? { contractId: id, pageSize: 200 } : undefined);

  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<{ milestoneId: string | null } | null>(null);
  const [addingExpense, setAddingExpense] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteContract = useDeleteContract();
  // UX hints only; the API checks every write.
  const ability = useAbility();
  const canUpdate = ability.can('update', 'Contract');
  const canDelete = ability.can('delete', 'Contract');

  if (checking || !allowed) {
    return (
      <div className="p-6 text-sm text-ink-muted">
        {checking ? 'Checking access…' : 'Redirecting…'}
      </div>
    );
  }

  if (contract.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const c = contract.data;
  if (contract.isError && !c) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 p-4 sm:p-6">
        <QueryError
          message="Couldn't load this contract."
          onRetry={() => void contract.refetch()}
        />
        <Link href="/financials" className="text-sm underline">
          Back to Financials
        </Link>
      </div>
    );
  }
  if (!c) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <p className="text-sm text-ink-muted">Contract not found.</p>
        <Link href="/financials" className="text-sm underline">
          Back to Financials
        </Link>
      </div>
    );
  }

  const outstanding = Number(c.totalValue) - Number(c.amountPaid);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <Link
        href="/financials?tab=contracts"
        className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Financials
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{c.title}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {c.project?.name ?? 'No project'}
            {c.client ? ` · ${c.client.name}` : ''} ·{' '}
            {billingModelLabel(c.billingModel)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ContractStatusBadge status={c.status} />
            <PaymentStatusBadge status={c.paymentStatus} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canDelete ? (
            <Button variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          ) : null}
          {canUpdate ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          ) : null}
          <Button onClick={() => setPaying({ milestoneId: null })}>
            <Plus className="h-4 w-4" /> Record payment
          </Button>
        </div>
      </header>

      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Contract value" value={formatCurrency(c.totalValue, c.currency)} />
        <Stat label="Received" value={formatCurrency(c.amountPaid, c.currency)} />
        <Stat
          label="Outstanding"
          value={outstanding > 0 ? formatCurrency(outstanding, c.currency) : '-'}
        />
      </dl>

      <ContractTabs
        tab={tab}
        onChange={setTab}
        showMilestones={c.billingModel !== 'ONE_TIME'}
      />

      {tab === 'overview' ? (
        <section className="rounded-md border border-line bg-bg-surface p-4 text-sm">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Row label="Currency" value={c.currency} />
            <Row
              label="Booked rate"
              value={Number(c.fxRateToBase) === 1 ? 'Same as base' : c.fxRateToBase}
            />
            <Row
              label="Starts"
              value={c.startDate ? new Date(c.startDate).toLocaleDateString() : '-'}
            />
            <Row
              label="Ends"
              value={c.endDate ? new Date(c.endDate).toLocaleDateString() : '-'}
            />
            <Row label="Created by" value={c.createdBy?.name ?? '-'} />
            <Row label="Milestones" value={String(c.milestones.length)} />
          </dl>
          {c.notes ? (
            <>
              <hr className="my-4 border-line" />
              <p className="whitespace-pre-wrap text-ink-muted">{c.notes}</p>
            </>
          ) : null}
        </section>
      ) : null}

      {tab === 'milestones' ? (
        <MilestoneTable
          contract={c}
          canEdit={canUpdate}
          onRecordPayment={(milestoneId) => setPaying({ milestoneId })}
        />
      ) : null}

      {tab === 'payments' ? (
        payments.isError && !payments.data ? (
          <QueryError
            message="Couldn't load payments."
            onRetry={() => void payments.refetch()}
          />
        ) : (
          <PaymentList
            items={payments.data?.items ?? []}
            loading={payments.isLoading}
            showContract={false}
            milestones={c.milestones}
          />
        )
      ) : null}

      {tab === 'expenses' ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddingExpense(true)}>
              <Plus className="h-4 w-4" /> Record expense
            </Button>
          </div>
          {expenses.isError && !expenses.data ? (
            <QueryError
              message="Couldn't load expenses."
              onRetry={() => void expenses.refetch()}
            />
          ) : (
            <ExpenseList
              items={expenses.data?.items ?? []}
              loading={expenses.isLoading}
            />
          )}
        </div>
      ) : null}

      {tab === 'invoices' ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-bg-surface p-8 text-center text-sm text-ink-muted">
          <p>Raise an invoice for this contract, or use Invoice on a milestone row.</p>
          <Button asChild size="sm">
            <Link
              href={`/financials/invoices/new?${new URLSearchParams({
                contractId: c.id,
                ...(c.clientId ? { clientId: c.clientId } : {}),
                ...(c.projectId ? { projectId: c.projectId } : {}),
                currency: c.currency,
                description: c.title,
              }).toString()}`}
            >
              <Plus className="h-4 w-4" /> New invoice
            </Link>
          </Button>
        </div>
      ) : null}

      <ContractFormDialog
        open={editing}
        onOpenChange={setEditing}
        existing={c}
      />
      <ConfirmByTypingDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this contract?"
        description="The contract and its milestones leave every list. Payments already recorded against it stay counted in revenue - the money did arrive."
        challenge={c.title}
        challengeLabel="Type the contract title to confirm"
        confirmLabel="Delete contract"
        pending={deleteContract.isPending}
        onConfirm={() =>
          deleteContract.mutate(c.id, {
            onSuccess: () => {
              setDeleting(false);
              router.replace('/financials?tab=contracts');
            },
          })
        }
      />
      {paying ? (
        <PaymentFormDialog
          open
          onOpenChange={(o) => !o && setPaying(null)}
          contract={c}
          defaultMilestoneId={paying.milestoneId}
        />
      ) : null}
      <ExpenseFormDialog
        open={addingExpense}
        onOpenChange={setAddingExpense}
        contractId={c.id}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-bg-surface p-4">
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
