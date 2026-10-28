'use client';

import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BillingModel, ContractWithMilestones } from '@botss/shared-types';

import { BaseCurrencyNotice } from '@/components/financials/base-currency-notice';
import { BILLING_MODEL_OPTIONS, billingModelLabel } from '@/components/financials/finance-badges';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
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
import { Textarea } from '@/components/ui/textarea';
import { useFinanceBaseCurrency } from '@/hooks/use-client-billing';
import {
  useCreateContract,
  useFinanceClientPicker,
  useFinanceProjectPicker,
  useUpdateContract,
} from '@/hooks/use-finance';
import { fxRateProblem, rateAfterCurrencyChange } from '@/lib/finance-forms';
import { CURRENCY_OPTIONS, formatCurrency } from '@/lib/money';

interface MilestoneDraft {
  title: string;
  amount: string;
  dueDate: Date | null;
}

const EMPTY_MILESTONE: MilestoneDraft = { title: '', amount: '', dueDate: null };

/** A new contract's starting currency. */
const NEW_CONTRACT_CURRENCY = 'USD';

export function ContractFormDialog({
  open,
  onOpenChange,
  existing,
  /** Preselects the project when opened from a project context. */
  defaultProjectId,
  /** Preselects the client when opened from a client's page. */
  defaultClientId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing?: ContractWithMilestones | null;
  defaultProjectId?: string | null;
  defaultClientId?: string | null;
}) {
  const base = useFinanceBaseCurrency();
  const { baseCurrency } = base;
  const isEdit = !!existing;
  const create = useCreateContract();
  const update = useUpdateContract();

  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [billingModel, setBillingModel] = useState<BillingModel>('ONE_TIME');
  const [currency, setCurrency] = useState(NEW_CONTRACT_CURRENCY);
  const [totalValue, setTotalValue] = useState('');
  const [fxRateToBase, setFxRateToBase] = useState('1');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [notes, setNotes] = useState('');
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([{ ...EMPTY_MILESTONE }]);
  const [error, setError] = useState<string | null>(null);

  const projects = useFinanceProjectPicker();
  const clients = useFinanceClientPicker();

  // Latest values for the effects below, which must not re-run (and reset
  // the form) when only these change.
  const latest = useRef({ baseCurrency, open, existing, currency });
  latest.current = { baseCurrency, open, existing, currency };

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (existing) {
      setTitle(existing.title);
      setProjectId(existing.projectId);
      setClientId(existing.clientId);
      setBillingModel(existing.billingModel);
      setCurrency(existing.currency);
      setTotalValue(existing.totalValue);
      setFxRateToBase(existing.fxRateToBase);
      setStartDate(existing.startDate ? new Date(existing.startDate) : null);
      setEndDate(existing.endDate ? new Date(existing.endDate) : null);
      setNotes(existing.notes ?? '');
      setMilestones([{ ...EMPTY_MILESTONE }]);
    } else {
      setTitle('');
      setProjectId(defaultProjectId ?? null);
      setClientId(defaultClientId ?? null);
      setBillingModel('ONE_TIME');
      setCurrency(NEW_CONTRACT_CURRENCY);
      // Keep the ref in step now: the late-base effect may run in this same
      // commit and must not see the previous session's currency.
      latest.current.currency = NEW_CONTRACT_CURRENCY;
      setTotalValue('');
      // The base currency books at 1; any other starts blank so its rate is
      // entered. If the base currency is not known yet, the effect below
      // fills it on arrival.
      setFxRateToBase(latest.current.baseCurrency === NEW_CONTRACT_CURRENCY ? '1' : '');
      setStartDate(null);
      setEndDate(null);
      setNotes('');
      setMilestones([{ ...EMPTY_MILESTONE }]);
    }
  }, [open, existing, defaultProjectId, defaultClientId]);

  // Only for a base currency that arrives after the dialog opened: book a new
  // base-currency contract at 1 while its rate is still empty (untouched).
  useEffect(() => {
    const now = latest.current;
    if (!baseCurrency || !now.open || now.existing) return;
    if (now.currency !== baseCurrency) return;
    setFxRateToBase((r) => (r === '' ? '1' : r));
  }, [baseCurrency]);

  const projectOptions = useMemo(
    () =>
      (projects.data?.items ?? []).map((p) => ({
        value: p.id,
        label: p.name,
        description: p.key,
      })),
    [projects.data],
  );
  const clientOptions = useMemo(
    () => (clients.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
    [clients.data],
  );

  /** Picking a project fills in its client and, if blank, the contract title. */
  function onPickProject(next: string | null) {
    setProjectId(next);
    const picked = projects.data?.items.find((p) => p.id === next);
    if (picked) {
      if (picked.clientId) setClientId(picked.clientId);
      if (!title.trim()) setTitle(picked.name);
    }
  }

  const isMilestoneModel = billingModel !== 'ONE_TIME';

  // For milestone contracts the stage sum IS the contract value - showing the
  // running total here stops the finance manager entering a figure that the
  // server would silently overwrite.
  const milestoneTotal = useMemo(
    () =>
      milestones.reduce((acc, m) => {
        const n = Number(m.amount);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0),
    [milestones],
  );

  // The booked rate is against the base currency: wait until it is known.
  const baseKnown = baseCurrency !== null;
  const sameCurrency = baseKnown && currency === baseCurrency;
  const rateError = baseKnown
    ? fxRateProblem({
        currency,
        previousCurrency: existing?.currency ?? baseCurrency,
        previousRate: existing?.fxRateToBase ?? '1',
        fxRate: fxRateToBase,
        baseCurrency,
      })
    : null;
  // The base currency always books at 1, whatever the field held before.
  const rateToSend = sameCurrency ? '1' : fxRateToBase;

  function onCurrencyChange(next: string) {
    if (baseCurrency) {
      setFxRateToBase(
        rateAfterCurrencyChange({
          previousCurrency: currency,
          nextCurrency: next,
          currentRate: fxRateToBase,
          baseCurrency,
          ...(existing
            ? { stored: { currency: existing.currency, rate: existing.fxRateToBase } }
            : {}),
        }),
      );
    }
    setCurrency(next);
  }

  async function submit() {
    setError(null);
    if (!title.trim()) {
      setError('Give the contract a name.');
      return;
    }
    if (!projectId && !clientId) {
      setError('Pick a project or a client so the revenue is attributable.');
      return;
    }
    if (!baseKnown || rateError) return;

    try {
      if (isEdit && existing) {
        await update.mutateAsync({
          id: existing.id,
          input: {
            title: title.trim(),
            projectId,
            clientId,
            billingModel,
            currency,
            totalValue: totalValue === '' ? undefined : totalValue,
            fxRateToBase: rateToSend,
            startDate,
            endDate,
            notes: notes.trim() === '' ? null : notes.trim(),
          },
        });
      } else {
        const drafts = milestones.filter((m) => m.title.trim() !== '');
        await create.mutateAsync({
          title: title.trim(),
          ...(projectId ? { projectId } : {}),
          ...(clientId ? { clientId } : {}),
          billingModel,
          currency,
          ...(isMilestoneModel ? {} : { totalValue: totalValue || '0' }),
          fxRateToBase: rateToSend,
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(isMilestoneModel && drafts.length > 0
            ? {
                milestones: drafts.map((m) => ({
                  title: m.title.trim(),
                  amount: m.amount || '0',
                  ...(m.dueDate ? { dueDate: m.dueDate } : {}),
                })),
              }
            : {}),
        });
      }
      onOpenChange(false);
    } catch {
      // The mutation hook already surfaced a toast; keep the dialog open.
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit contract' : 'New contract'}</DialogTitle>
          <DialogDescription>
            What was agreed with the client, and how it gets billed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name" htmlFor="contract-title">
            <Input
              id="contract-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Website rebuild - phase 1"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project">
              <Combobox
                options={projectOptions}
                value={projectId}
                onChange={onPickProject}
                placeholder="Select a project…"
                clearable
              />
              <p className="text-ink-muted mt-1 text-xs">
                No project yet?{' '}
                <Link href="/projects" className="underline">
                  Create one first
                </Link>
                .
              </p>
            </Field>

            <Field label="Client">
              <Combobox
                options={clientOptions}
                value={clientId}
                onChange={setClientId}
                placeholder="Select a client…"
                clearable
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Billing model">
              <Select
                value={billingModel}
                onValueChange={(v) => setBillingModel(v as BillingModel)}
                disabled={isEdit}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILLING_MODEL_OPTIONS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {billingModelLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Currency">
              <Select value={currency} onValueChange={onCurrencyChange} disabled={!baseKnown}>
                <SelectTrigger>
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
            </Field>
          </div>

          {!isMilestoneModel ? (
            <Field label="Total value">
              <Input
                inputMode="decimal"
                value={totalValue}
                onChange={(e) => setTotalValue(e.target.value)}
                placeholder="0.00"
              />
            </Field>
          ) : null}

          {baseKnown && !sameCurrency ? (
            <Field label={`Exchange rate to ${baseCurrency}`}>
              <Input
                inputMode="decimal"
                value={fxRateToBase}
                onChange={(e) => setFxRateToBase(e.target.value)}
                placeholder="278.50"
                aria-invalid={rateError ? true : undefined}
                aria-describedby={rateError ? 'contract-fx-error' : undefined}
              />
              {rateError ? (
                <p id="contract-fx-error" className="text-state-error mt-1 text-xs">
                  {rateError}
                </p>
              ) : null}
              <p className="text-ink-muted mt-1 text-xs">
                Booked once, now. Outstanding is reported at this rate; money actually received is
                converted at whatever rate applied on the day it landed.
              </p>
            </Field>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date">
              <DatePicker value={startDate} onChange={setStartDate} />
            </Field>
            <Field label="End date">
              <DatePicker value={endDate} onChange={setEndDate} />
            </Field>
          </div>

          {isMilestoneModel && !isEdit ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Milestones</Label>
                <span className="text-ink-muted text-xs">
                  Total {formatCurrency(milestoneTotal, currency)}
                </span>
              </div>
              {milestones.map((m, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input
                    aria-label={`Milestone ${i + 1} name`}
                    className="flex-1"
                    value={m.title}
                    onChange={(e) =>
                      setMilestones((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                      )
                    }
                    placeholder={`Stage ${i + 1}`}
                  />
                  <Input
                    aria-label={`Milestone ${i + 1} amount`}
                    className="w-32"
                    inputMode="decimal"
                    value={m.amount}
                    onChange={(e) =>
                      setMilestones((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                      )
                    }
                    placeholder="0.00"
                  />
                  <div className="w-40">
                    <DatePicker
                      size="sm"
                      value={m.dueDate}
                      onChange={(d) =>
                        setMilestones((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, dueDate: d } : x)),
                        )
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove milestone ${i + 1}`}
                    onClick={() =>
                      setMilestones((prev) =>
                        prev.length === 1
                          ? [{ ...EMPTY_MILESTONE }]
                          : prev.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setMilestones((prev) => [...prev, { ...EMPTY_MILESTONE }])}
              >
                <Plus className="h-4 w-4" /> Add milestone
              </Button>
            </div>
          ) : null}

          <Field label="Notes">
            <Textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Scope, payment terms, anything the invoice should reflect."
            />
          </Field>

          {error ? <p className="text-state-error text-sm">{error}</p> : null}
        </div>

        <BaseCurrencyNotice base={base} />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !baseKnown || !!rateError}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create contract'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
