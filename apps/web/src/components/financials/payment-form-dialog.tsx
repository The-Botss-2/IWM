'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContractWithMilestones,
  PaymentRegion,
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
import { useCreatePayment, usePaymentSources } from '@/hooks/use-finance';
import { fxRateProblem, rateAfterCurrencyChange } from '@/lib/finance-forms';
import { CURRENCY_OPTIONS, formatCurrency } from '@/lib/money';

/**
 * Field order is deliberate and matches how a finance manager thinks:
 *
 *   1. How much of the contract does this settle?  (amount, contract currency)
 *   2. Where did it come from?                     (source, region)
 *   3. What actually landed in the bank?           (collapsed by default)
 *
 * The third group is hidden behind a disclosure so the common case - client
 * paid exactly what we billed, no platform fee - is three fields, not eight.
 */
export function PaymentFormDialog({
  open,
  onOpenChange,
  contract,
  /** Preselects a milestone when opened from a milestone row. */
  defaultMilestoneId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithMilestones;
  defaultMilestoneId?: string | null;
}) {
  const base = useFinanceBaseCurrency();
  const { baseCurrency } = base;
  const create = useCreatePayment();
  const sources = usePaymentSources();

  const [amount, setAmount] = useState('');
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  const [paymentSourceId, setPaymentSourceId] = useState<string | null>(null);
  const [region, setRegion] = useState<PaymentRegion>('LOCAL');
  const [paidAt, setPaidAt] = useState<Date | null>(new Date());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const [showDetail, setShowDetail] = useState(false);
  const [receivedAmount, setReceivedAmount] = useState('');
  const [receivedCurrency, setReceivedCurrency] = useState(contract.currency);
  const [feeAmount, setFeeAmount] = useState('');
  const [fxRate, setFxRate] = useState('1');
  // The rate is filled from the base currency once known, unless typed.
  const [rateTouched, setRateTouched] = useState(false);

  /** The starting rate for money landing in the contract currency. */
  const startingRate = (base: string | null) =>
    base === null ? '' : contract.currency === base ? '1' : contract.fxRateToBase;
  // Latest values for the late-base effect below, which must not re-run when
  // only these change.
  const contractCurrency = contract.currency;
  const latest = useRef({ baseCurrency, open, rateTouched, receivedCurrency, contractCurrency, startingRate });
  latest.current = { baseCurrency, open, rateTouched, receivedCurrency, contractCurrency, startingRate };

  useEffect(() => {
    if (!open) return;
    setAmount('');
    setMilestoneId(defaultMilestoneId ?? null);
    setPaymentSourceId(null);
    setRegion('LOCAL');
    setPaidAt(new Date());
    setReference('');
    setNotes('');
    setShowDetail(false);
    setReceivedAmount('');
    setReceivedCurrency(contract.currency);
    setFeeAmount('');
    setFxRate(latest.current.startingRate(latest.current.baseCurrency));
    setRateTouched(false);
    // Keep the ref in step now: the late-base effect may run in this same
    // commit and must not see the previous session's values.
    latest.current.receivedCurrency = contract.currency;
    latest.current.rateTouched = false;
  }, [open, defaultMilestoneId, contract.currency]);

  // Only for a base currency that arrives after the dialog opened: fill the
  // starting rate while it is still empty and untouched.
  useEffect(() => {
    const now = latest.current;
    if (!baseCurrency || !now.open || now.rateTouched) return;
    if (now.receivedCurrency !== now.contractCurrency) return;
    setFxRate((r) => (r === '' ? now.startingRate(baseCurrency) : r));
  }, [baseCurrency]);

  // Picking a rail fills in its region and typical fee, both still editable.
  function onPickSource(id: string | null) {
    setPaymentSourceId(id);
    const src = sources.data?.items.find((s) => s.id === id);
    if (!src) return;
    if (src.defaultRegion) setRegion(src.defaultRegion);
    if (src.defaultFeePercent) {
      const gross = Number(receivedAmount || amount);
      if (Number.isFinite(gross) && gross > 0) {
        setFeeAmount(((gross * Number(src.defaultFeePercent)) / 100).toFixed(2));
        setShowDetail(true);
      }
    }
  }

  // Rate checks need the real base currency; until it is known, wait.
  const baseCode = baseCurrency ?? '';
  const baseKnown = baseCurrency !== null;
  const sameCurrency = baseKnown && receivedCurrency === baseCode;
  // The rate the form starts from for money landing in the contract currency.
  const contractRate = contract.currency === baseCode ? '1' : contract.fxRateToBase;
  // Money landing in another currency than the contract's needs its own rate.
  const rateError = baseKnown
    ? fxRateProblem({
        currency: receivedCurrency,
        previousCurrency: contract.currency,
        previousRate: contractRate,
        fxRate,
        baseCurrency: baseCode,
      })
    : null;

  // Live preview of what the dashboard will actually record, so a wrong rate
  // is caught before saving rather than in next month's report.
  const basePreview = useMemo(() => {
    const gross = Number(receivedAmount === '' ? amount : receivedAmount);
    const fee = Number(feeAmount || 0);
    const r = sameCurrency ? 1 : Number(fxRate || 0);
    if (!Number.isFinite(gross) || !Number.isFinite(fee) || !Number.isFinite(r)) {
      return null;
    }
    return (gross - fee) * r;
  }, [amount, receivedAmount, feeAmount, fxRate, sameCurrency]);

  const outstanding = useMemo(() => {
    const total = Number(contract.totalValue);
    const paid = Number(contract.amountPaid);
    if (!Number.isFinite(total) || !Number.isFinite(paid)) return null;
    return total - paid;
  }, [contract.totalValue, contract.amountPaid]);

  async function submit() {
    try {
      await create.mutateAsync({
        contractId: contract.id,
        ...(milestoneId ? { milestoneId } : {}),
        amount: amount || '0',
        currency: contract.currency,
        ...(receivedAmount ? { receivedAmount } : {}),
        receivedCurrency,
        ...(feeAmount ? { feeAmount } : {}),
        fxRate: sameCurrency ? '1' : fxRate,
        ...(paymentSourceId ? { paymentSourceId } : {}),
        region,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(paidAt ? { paidAt } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onOpenChange(false);
    } catch {
      // Toast already raised by the hook; leave the dialog open to correct.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            {contract.title}
            {outstanding != null && outstanding > 0 ? (
              <>
                {' · '}
                {formatCurrency(outstanding, contract.currency)} outstanding
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="pay-amount">
              Amount ({contract.currency})
            </Label>
            <Input
              id="pay-amount"
              className="mt-1"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
            <p className="mt-1 text-xs text-ink-muted">
              How much of the contract this settles. Always in the contract
              currency, even if the money arrived as something else.
            </p>
          </div>

          {contract.milestones.length > 0 ? (
            <div>
              <Label>Milestone</Label>
              <Select
                value={milestoneId ?? '__none__'}
                onValueChange={(v) => setMilestoneId(v === '__none__' ? null : v)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Against the contract</SelectItem>
                  {contract.milestones.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.title} · {formatCurrency(m.amount, contract.currency)}
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
                  value={paymentSourceId}
                  onChange={onPickSource}
                />
              </div>
            </div>
            <div>
              <Label>Region</Label>
              <Select
                value={region}
                onValueChange={(v) => setRegion(v as PaymentRegion)}
              >
                <SelectTrigger className="mt-1">
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
                <DatePicker value={paidAt} onChange={setPaidAt} />
              </div>
            </div>
            <div>
              <Label htmlFor="pay-ref">Reference</Label>
              <Input
                id="pay-ref"
                className="mt-1"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Bank / transaction id"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
          >
            {showDetail ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Different from the contract amount?
          </button>

          {showDetail ? (
            <div className="space-y-4 rounded-md border border-line bg-bg-subtle p-3">
              <p className="text-xs text-ink-muted">
                Use these when the money landed as a different amount or
                currency - an Upwork payout, say, where the client was billed{' '}
                {contract.currency} but a fee was taken and the rest wired
                locally.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pay-received">Received (gross)</Label>
                  <Input
                    id="pay-received"
                    className="mt-1"
                    inputMode="decimal"
                    value={receivedAmount}
                    onChange={(e) => setReceivedAmount(e.target.value)}
                    placeholder={amount || '0.00'}
                  />
                </div>
                <div>
                  <Label>Received currency</Label>
                  <Select
                    value={receivedCurrency}
                    disabled={!baseKnown}
                    onValueChange={(v) => {
                      setRateTouched(true);
                      setFxRate(
                        rateAfterCurrencyChange({
                          previousCurrency: receivedCurrency,
                          nextCurrency: v,
                          currentRate: fxRate,
                          baseCurrency: baseCode,
                          stored: { currency: contract.currency, rate: contractRate },
                        }),
                      );
                      setReceivedCurrency(v);
                    }}
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
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pay-fee">Platform fee</Label>
                  <Input
                    id="pay-fee"
                    className="mt-1"
                    inputMode="decimal"
                    value={feeAmount}
                    onChange={(e) => setFeeAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <Label htmlFor="pay-fx">Rate to {baseCurrency ?? 'base'}</Label>
                  <Input
                    id="pay-fx"
                    className="mt-1"
                    inputMode="decimal"
                    value={sameCurrency ? '1' : fxRate}
                    onChange={(e) => {
                      setRateTouched(true);
                      setFxRate(e.target.value);
                    }}
                    disabled={sameCurrency || !baseKnown}
                    aria-invalid={rateError ? true : undefined}
                    aria-describedby={rateError ? 'pay-fx-error' : undefined}
                  />
                  {rateError ? (
                    <p id="pay-fx-error" className="mt-1 text-xs text-state-error">
                      {rateError}
                    </p>
                  ) : null}
                </div>
              </div>
              {basePreview != null ? (
                <p className="text-sm">
                  <span className="text-ink-muted">Recorded as revenue: </span>
                  <span className="font-medium tabular-nums">
                    {formatCurrency(basePreview, baseCode)}
                  </span>
                  <span className="text-ink-muted"> (net of fee)</span>
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <Label htmlFor="pay-notes">Notes</Label>
            <Textarea
              id="pay-notes"
              className="mt-1"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <BaseCurrencyNotice base={base} />
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending || !baseKnown || !!rateError || amount.trim() === ''}
          >
            {create.isPending ? 'Saving…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
