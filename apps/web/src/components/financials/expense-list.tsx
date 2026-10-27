'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ExpenseCategory, ExpenseWithRefs } from '@botss/shared-types';

import {
  CATEGORY_LABEL,
  EXPENSE_CATEGORY_OPTIONS,
} from '@/components/financials/finance-badges';
import { BaseCurrencyNotice } from '@/components/financials/base-currency-notice';
import { PaymentSourceCombobox } from '@/components/financials/payment-source-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useCreateExpense,
  useDeleteExpense,
  useFinanceProjectPicker,
  useUpdateExpense,
} from '@/hooks/use-finance';
import { useFinanceBaseCurrency } from '@/hooks/use-client-billing';
import { useAbility } from '@/lib/ability';
import {
  expenseChanges,
  expenseFormFrom,
  fxRateProblem,
  rateAfterCurrencyChange,
  type ExpenseForm,
} from '@/lib/finance-forms';
import { CURRENCY_OPTIONS, formatCurrency } from '@/lib/money';

export function ExpenseList({
  items,
  loading,
}: {
  items: ExpenseWithRefs[];
  loading?: boolean;
}) {
  const del = useDeleteExpense();
  const [confirming, setConfirming] = useState<ExpenseWithRefs | null>(null);
  const [editing, setEditing] = useState<ExpenseWithRefs | null>(null);
  const { baseCurrency } = useFinanceBaseCurrency();
  // UX hints; the API checks every write.
  const ability = useAbility();
  const canUpdate = ability.can('update', 'Expense');
  const canDelete = ability.can('delete', 'Expense');

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line bg-bg-surface p-8 text-center text-sm text-ink-muted">
        No expenses recorded. Costs logged here are what turn revenue into
        profit on the overview.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">{baseCurrency ?? 'Base'}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0 hover:bg-bg-subtle">
                <td className="px-3 py-2 whitespace-nowrap">
                  {new Date(e.incurredAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2">
                  {e.description}
                  {e.vendor ? (
                    <span className="block text-xs text-ink-muted">{e.vendor}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge tone="neutral">{CATEGORY_LABEL[e.category]}</Badge>
                    {e.fromPayroll ? <Badge tone="info">Payroll</Badge> : null}
                  </div>
                </td>
                <td className="px-3 py-2 text-ink-muted">
                  {e.project?.name ?? 'Overhead'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(e.amount, e.currency)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">
                  {baseCurrency ? formatCurrency(e.baseAmount, baseCurrency) : e.baseAmount}
                </td>
                <td className="px-3 py-2 text-right">
                  {/* A payroll run owns its salary rows: they change through
                      the run (undo paid), never here. */}
                  {e.fromPayroll ? null : (
                    <div className="flex justify-end gap-1">
                      {canUpdate ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${e.description}`}
                          onClick={() => setEditing(e)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {canDelete ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${e.description}`}
                          onClick={() => setConfirming(e)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden" role="list">
        {items.map((e) => (
          <li key={e.id} className="rounded-md border border-line bg-bg-surface p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{e.description}</span>
              <span className="tabular-nums">{formatCurrency(e.amount, e.currency)}</span>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">
              {CATEGORY_LABEL[e.category]} · {e.project?.name ?? 'Overhead'} ·{' '}
              {new Date(e.incurredAt).toLocaleDateString()}
            </p>
            {e.fromPayroll ? (
              <div className="mt-2">
                <Badge tone="info">Payroll</Badge>
              </div>
            ) : canUpdate || canDelete ? (
              <div className="mt-2 flex justify-end gap-1">
                {canUpdate ? (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(e)}>
                    Edit
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(e)}>
                    Delete
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="Delete this expense?"
        description={confirming?.description ?? ''}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!confirming) return;
          try {
            await del.mutateAsync(confirming.id);
            setConfirming(null);
          } catch {
            // Toast raised by the hook; keep the dialog open.
          }
        }}
      />
      <ExpenseFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        existing={editing}
      />
    </>
  );
}

/** Currency starts empty and is filled once the base currency is known. */
const emptyExpense = (): ExpenseForm => ({
  description: '',
  vendor: '',
  category: 'OTHER',
  projectId: null,
  amount: '',
  currency: '',
  fxRate: '1',
  paymentSourceId: null,
  incurredAt: new Date(),
});

/** Record an expense, or edit `existing` (only the changed fields are sent). */
export function ExpenseFormDialog({
  open,
  onOpenChange,
  contractId,
  existing = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId?: string | null;
  existing?: ExpenseWithRefs | null;
}) {
  const base = useFinanceBaseCurrency();
  const { baseCurrency } = base;
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const projects = useFinanceProjectPicker();
  const [form, setForm] = useState<ExpenseForm>(emptyExpense);
  const set = <K extends keyof ExpenseForm>(key: K, value: ExpenseForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!open) return;
    setForm(existing ? expenseFormFrom(existing) : emptyExpense());
  }, [open, existing]);

  // A new expense defaults to the base currency once it is known, without
  // touching anything already typed.
  useEffect(() => {
    if (!open || !baseCurrency) return;
    setForm((f) => (f.currency ? f : { ...f, currency: baseCurrency }));
  }, [open, baseCurrency]);

  // Every rate check needs the real base currency; until it is known the
  // form waits instead of guessing.
  const baseCode = baseCurrency ?? '';
  const baseKnown = baseCurrency !== null;
  const sameCurrency = baseKnown && form.currency === baseCode;
  const pending = create.isPending || update.isPending;
  const rateError = baseKnown
    ? fxRateProblem({
        currency: form.currency,
        previousCurrency: existing?.currency ?? baseCode,
        previousRate: existing?.fxRate ?? '1',
        fxRate: form.fxRate,
        baseCurrency: baseCode,
      })
    : null;

  // The edited project may be missing from the picker's first page.
  const projectOptions = (projects.data?.items ?? []).map((p) => ({
    value: p.id,
    label: p.name,
    description: p.key,
  }));
  if (existing?.project && !projectOptions.some((o) => o.value === existing.project?.id)) {
    projectOptions.unshift({ value: existing.project.id, label: existing.project.name, description: '' });
  }

  async function submit() {
    try {
      if (existing) {
        const changes = expenseChanges(existing, form, baseCode);
        if (Object.keys(changes).length > 0) {
          await update.mutateAsync({ id: existing.id, input: changes });
        }
      } else {
        await create.mutateAsync({
          description: form.description.trim(),
          ...(form.vendor.trim() ? { vendor: form.vendor.trim() } : {}),
          category: form.category,
          ...(form.projectId ? { projectId: form.projectId } : {}),
          ...(contractId ? { contractId } : {}),
          amount: form.amount || '0',
          currency: form.currency,
          fxRate: sameCurrency ? '1' : form.fxRate,
          ...(form.paymentSourceId ? { paymentSourceId: form.paymentSourceId } : {}),
          ...(form.incurredAt ? { incurredAt: form.incurredAt } : {}),
        });
      }
      onOpenChange(false);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit expense' : 'Record an expense'}</DialogTitle>
          <DialogDescription>
            Money out. Leave the project blank for company overhead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="exp-desc">Description</Label>
            <Input
              id="exp-desc"
              className="mt-1"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Figma team seats - August"
              autoFocus
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => set('category', v as ExpenseCategory)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="exp-vendor">Vendor</Label>
              <Input
                id="exp-vendor"
                className="mt-1"
                value={form.vendor}
                onChange={(e) => set('vendor', e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label>Project</Label>
            <div className="mt-1">
              <Combobox
                options={projectOptions}
                value={form.projectId}
                onChange={(id) => set('projectId', id)}
                placeholder="Company overhead"
                clearable
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="exp-amount">Amount</Label>
              <Input
                id="exp-amount"
                className="mt-1"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label>Currency</Label>
              <Select
                value={form.currency}
                disabled={!baseKnown}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    currency: v,
                    fxRate: rateAfterCurrencyChange({
                      previousCurrency: f.currency,
                      nextCurrency: v,
                      currentRate: f.fxRate,
                      baseCurrency: baseCode,
                      ...(existing ? { stored: { currency: existing.currency, rate: existing.fxRate } } : {}),
                    }),
                  }))
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="exp-fx">Rate to {baseCurrency ?? 'base'}</Label>
              <Input
                id="exp-fx"
                className="mt-1"
                inputMode="decimal"
                value={sameCurrency ? '1' : form.fxRate}
                onChange={(e) => set('fxRate', e.target.value)}
                disabled={sameCurrency || !baseKnown}
                aria-invalid={rateError ? true : undefined}
                aria-describedby={rateError ? 'exp-fx-error' : undefined}
              />
              {rateError ? (
                <p id="exp-fx-error" className="mt-1 text-xs text-state-error">
                  {rateError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Paid from</Label>
              <div className="mt-1">
                <PaymentSourceCombobox
                  value={form.paymentSourceId}
                  onChange={(id) => set('paymentSourceId', id)}
                />
              </div>
            </div>
            <div>
              <Label>Date</Label>
              <div className="mt-1">
                <DatePicker value={form.incurredAt} onChange={(d) => set('incurredAt', d)} />
              </div>
            </div>
          </div>
        </div>

        <BaseCurrencyNotice base={base} />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              pending ||
              !baseKnown ||
              !form.currency ||
              !!rateError ||
              !form.description.trim() ||
              !form.amount.trim()
            }
          >
            {pending ? 'Saving…' : existing ? 'Save expense' : 'Record expense'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
