'use client';

import { useEffect, useState } from 'react';
import { payPayrollRunSchema, type PayrollRun } from '@botss/shared-types';

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
import { usePayPayrollRun } from '@/hooks/use-payroll';
import { formatCurrency } from '@/lib/money';
import { normalizeRate, PAYROLL_CURRENCY, payrollPeriod, toPayDate } from '@/lib/payroll';

/**
 * Mark a run paid. The server records one salary expense per person, so the
 * dialog says so plainly: this is the step that changes the books.
 */
export function MarkPaidDialog({
  run,
  open,
  onOpenChange,
  baseCurrency,
}: {
  run: PayrollRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the organization's reporting currency is still loading. */
  baseCurrency: string | null;
}) {
  const pay = usePayPayrollRun(run.id);
  const [paidAt, setPaidAt] = useState<Date | null>(new Date());
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [fxRate, setFxRate] = useState('');
  const needsFx = baseCurrency !== null && baseCurrency !== PAYROLL_CURRENCY;

  useEffect(() => {
    if (!open) return;
    setPaidAt(new Date());
    setSourceId(null);
    setFxRate('');
  }, [open]);

  const paying = run.items.filter((i) => Number(i.net) > 0).length;
  const rate = needsFx ? normalizeRate(fxRate) : null;
  const rateInvalid = needsFx && fxRate.trim() !== '' && rate === null;

  async function submit() {
    if (!paidAt) return;
    if (needsFx && rate === null) return;
    const parsed = payPayrollRunSchema.safeParse({
      paidAt: toPayDate(paidAt),
      paymentSourceId: sourceId,
      ...(needsFx && rate ? { fxRate: rate } : {}),
    });
    if (!parsed.success) return;
    try {
      await pay.mutateAsync(parsed.data);
      onOpenChange(false);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {payrollPeriod(run.year, run.month)} as paid</DialogTitle>
          <DialogDescription>
            Records {paying === 1 ? '1 salary' : `${paying} salaries`} totalling{' '}
            {formatCurrency(run.totalNet, PAYROLL_CURRENCY)} as expenses. You can undo this later if
            something needs correcting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-date">Paid on</Label>
            <DatePicker id="pay-date" value={paidAt} onChange={setPaidAt} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-source">Paid from</Label>
            <PaymentSourceCombobox id="pay-source" value={sourceId} onChange={setSourceId} />
          </div>
          {baseCurrency === null ? (
            <p className="text-ink-muted text-xs" role="status">
              Loading your reporting currency…
            </p>
          ) : null}
          {needsFx ? (
            <div className="space-y-1.5">
              <Label htmlFor="pay-fx">PKR to {baseCurrency} rate</Label>
              <Input
                id="pay-fx"
                inputMode="decimal"
                placeholder="e.g. 0.0036"
                value={fxRate}
                aria-invalid={rateInvalid}
                aria-describedby="pay-fx-help"
                onChange={(e) => setFxRate(e.target.value)}
              />
              {rateInvalid ? (
                <p id="pay-fx-help" role="alert" className="text-state-error text-xs">
                  Enter the rate with a period for decimals, e.g. 0.0036.
                </p>
              ) : (
                <p id="pay-fx-help" className="text-ink-muted text-xs">
                  Reports are in {baseCurrency}, so each salary is converted at this rate.
                </p>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              !paidAt || baseCurrency === null || pay.isPending || (needsFx && rate === null)
            }
          >
            {pay.isPending ? 'Saving…' : 'Mark as paid'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
