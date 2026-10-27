'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type {
  ContractMilestone,
  PaymentRegion,
  PaymentWithSource,
} from '@botss/shared-types';

import { BaseCurrencyNotice } from '@/components/financials/base-currency-notice';
import { PaymentSourceCombobox } from '@/components/financials/payment-source-combobox';
import { Button } from '@/components/ui/button';
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
import { useUpdatePayment } from '@/hooks/use-finance';
import {
  fxRateProblem,
  landedAsBilled,
  paymentChanges,
  paymentFormFrom,
  rateAfterCurrencyChange,
  type PaymentForm,
} from '@/lib/finance-forms';
import { CURRENCY_OPTIONS, formatCurrency } from '@/lib/money';

const NO_MILESTONE = '__none__';

/**
 * Correct a recorded payment. The contract (or invoice) it settles is fixed -
 * moving money between contracts is a void and a new payment - so the
 * currency of `amount` is shown, not edited. The milestone picker appears
 * only when the caller passes the contract's milestones. Mount it per
 * payment (`key={payment.id}`); it closes through `onClose`.
 */
export function PaymentEditDialog({
  payment,
  onClose,
  milestones,
}: {
  payment: PaymentWithSource;
  onClose: () => void;
  milestones?: ContractMilestone[];
}) {
  const base = useFinanceBaseCurrency();
  const { baseCurrency } = base;
  const update = useUpdatePayment();
  const [form, setForm] = useState<PaymentForm>(() => paymentFormFrom(payment));
  const [showDetail, setShowDetail] = useState(() => !landedAsBilled(payment));
  const [receivedTouched, setReceivedTouched] = useState(false);

  const set = <K extends keyof PaymentForm>(key: K, value: PaymentForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // A payment that landed exactly as billed keeps doing so while the
  // received amount has not been edited on its own.
  const followsAmount = landedAsBilled(payment) && !receivedTouched;
  const onAmount = (amount: string) =>
    setForm((f) => ({ ...f, amount, ...(followsAmount ? { receivedAmount: amount } : {}) }));

  // Rate checks need the real base currency; until it is known, wait.
  const baseCode = baseCurrency ?? '';
  const baseKnown = baseCurrency !== null;
  const sameCurrency = baseKnown && form.receivedCurrency === baseCode;
  const changes = paymentChanges(payment, form, baseCode);
  const dirty = Object.keys(changes).length > 0;
  const rateError = baseKnown
    ? fxRateProblem({
        currency: form.receivedCurrency,
        previousCurrency: payment.receivedCurrency,
        previousRate: payment.fxRate,
        fxRate: form.fxRate,
        baseCurrency: baseCode,
      })
    : null;

  async function submit() {
    if (!dirty) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: payment.id, input: changes });
      onClose();
    } catch {
      // Toast raised by the hook; keep the dialog open to correct.
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit payment</DialogTitle>
          <DialogDescription>
            {payment.contract?.title ?? 'Invoice payment'} · recorded{' '}
            {new Date(payment.createdAt).toLocaleDateString()}. Totals are
            recalculated when you save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="pay-edit-amount">Amount ({payment.currency})</Label>
            <Input
              id="pay-edit-amount"
              className="mt-1"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => onAmount(e.target.value)}
              autoFocus
            />
          </div>

          {milestones && milestones.length > 0 ? (
            <div>
              <Label htmlFor="pay-edit-milestone">Milestone</Label>
              <Select
                value={form.milestoneId ?? NO_MILESTONE}
                onValueChange={(v) => set('milestoneId', v === NO_MILESTONE ? null : v)}
              >
                <SelectTrigger id="pay-edit-milestone" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MILESTONE}>Against the contract</SelectItem>
                  {milestones.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.title} · {formatCurrency(m.amount, payment.currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Source</Label>
              <div className="mt-1">
                <PaymentSourceCombobox
                  value={form.paymentSourceId}
                  onChange={(id) => set('paymentSourceId', id)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="pay-edit-region">Region</Label>
              <Select value={form.region} onValueChange={(v) => set('region', v as PaymentRegion)}>
                <SelectTrigger id="pay-edit-region" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOCAL">Local</SelectItem>
                  <SelectItem value="INTERNATIONAL">International</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Date received</Label>
              <div className="mt-1">
                <DatePicker value={form.paidAt} onChange={(d) => set('paidAt', d)} />
              </div>
            </div>
            <div>
              <Label htmlFor="pay-edit-ref">Reference</Label>
              <Input
                id="pay-edit-ref"
                className="mt-1"
                value={form.reference}
                onChange={(e) => set('reference', e.target.value)}
                placeholder="Bank / transaction id"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
            aria-expanded={showDetail}
          >
            {showDetail ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            What landed in the bank
          </button>

          {showDetail ? (
            <div className="space-y-4 rounded-md border border-line bg-bg-subtle p-3">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pay-edit-received">Received (gross)</Label>
                  <Input
                    id="pay-edit-received"
                    className="mt-1"
                    inputMode="decimal"
                    value={form.receivedAmount}
                    onChange={(e) => {
                      setReceivedTouched(true);
                      set('receivedAmount', e.target.value);
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="pay-edit-received-currency">Received currency</Label>
                  <Select
                    value={form.receivedCurrency}
                    disabled={!baseKnown}
                    onValueChange={(v) => {
                      setReceivedTouched(true);
                      setForm((f) => ({
                        ...f,
                        receivedCurrency: v,
                        fxRate: rateAfterCurrencyChange({
                          previousCurrency: f.receivedCurrency,
                          nextCurrency: v,
                          currentRate: f.fxRate,
                          baseCurrency: baseCode,
                          stored: { currency: payment.receivedCurrency, rate: payment.fxRate },
                        }),
                      }));
                    }}
                  >
                    <SelectTrigger id="pay-edit-received-currency" className="mt-1">
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
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pay-edit-fee">Platform fee</Label>
                  <Input
                    id="pay-edit-fee"
                    className="mt-1"
                    inputMode="decimal"
                    value={form.feeAmount}
                    onChange={(e) => {
                      setReceivedTouched(true);
                      set('feeAmount', e.target.value);
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="pay-edit-fx">Rate to {baseCurrency ?? 'base'}</Label>
                  <Input
                    id="pay-edit-fx"
                    className="mt-1"
                    inputMode="decimal"
                    value={sameCurrency ? '1' : form.fxRate}
                    onChange={(e) => set('fxRate', e.target.value)}
                    disabled={sameCurrency || !baseKnown}
                    aria-invalid={rateError ? true : undefined}
                    aria-describedby={rateError ? 'pay-edit-fx-error' : undefined}
                  />
                  {rateError ? (
                    <p id="pay-edit-fx-error" className="mt-1 text-xs text-state-error">
                      {rateError}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div>
            <Label htmlFor="pay-edit-notes">Notes</Label>
            <Textarea
              id="pay-edit-notes"
              className="mt-1"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>

        <BaseCurrencyNotice base={base} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              update.isPending || !baseKnown || !dirty || !!rateError || form.amount.trim() === ''
            }
          >
            {update.isPending ? 'Saving…' : 'Save payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
