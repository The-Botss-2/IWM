'use client';

import { useEffect, useState } from 'react';
import { type PayrollItem, updatePayrollItemSchema } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
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
import { useUpdatePayrollItem } from '@/hooks/use-payroll';
import { formatCurrency } from '@/lib/money';
import { PAYROLL_CURRENCY, payrollAmount, previewNet } from '@/lib/payroll';

/** One person's salary, bonus, commission, deduction and tax for this month. */
export function PayrollItemDialog({
  runId,
  item,
  onOpenChange,
}: {
  runId: string;
  item: PayrollItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdatePayrollItem(runId);
  const [salary, setSalary] = useState('');
  const [bonus, setBonus] = useState('');
  const [bonusNote, setBonusNote] = useState('');
  const [commission, setCommission] = useState('');
  const [deduction, setDeduction] = useState('');
  const [deductionNote, setDeductionNote] = useState('');
  const [tax, setTax] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setSalary(item.salary);
    setBonus(Number(item.bonus) > 0 ? item.bonus : '');
    setBonusNote(item.bonusNote ?? '');
    setCommission(Number(item.commission) > 0 ? item.commission : '');
    setDeduction(Number(item.deduction) > 0 ? item.deduction : '');
    setDeductionNote(item.deductionNote ?? '');
    setTax(Number(item.tax) > 0 ? item.tax : '');
    setError(null);
  }, [item]);

  const net = previewNet({ salary, bonus, commission, deduction, tax });

  async function submit() {
    if (!item) return;
    setError(null);
    const amounts = {
      salary: payrollAmount(salary),
      bonus: payrollAmount(bonus),
      commission: payrollAmount(commission),
      deduction: payrollAmount(deduction),
      tax: payrollAmount(tax),
    };
    if (Object.values(amounts).some((a) => a === null)) {
      setError('Amounts must be numbers of 0 or more.');
      return;
    }
    if (net !== null && net < 0) {
      setError('Deduction and tax are larger than salary, bonus and commission.');
      return;
    }
    const parsed = updatePayrollItemSchema.safeParse({ ...amounts, bonusNote, deductionNote });
    if (!parsed.success) {
      setError('Notes can be at most 300 characters.');
      return;
    }
    try {
      await update.mutateAsync({ itemId: item.id, input: parsed.data });
      onOpenChange(false);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item?.employeeName}</DialogTitle>
          <DialogDescription>Changes apply to this month only.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pi-salary">Salary</Label>
            <Input
              id="pi-salary"
              inputMode="decimal"
              className="tabular-nums"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="pi-bonus">Bonus</Label>
              <Input
                id="pi-bonus"
                inputMode="decimal"
                placeholder="0.00"
                className="tabular-nums"
                value={bonus}
                onChange={(e) => setBonus(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pi-bonus-note">Reason</Label>
              <Input
                id="pi-bonus-note"
                placeholder="Shown on the payslip"
                value={bonusNote}
                onChange={(e) => setBonusNote(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pi-commission">Commission</Label>
            <Input
              id="pi-commission"
              inputMode="decimal"
              placeholder="0.00"
              className="tabular-nums sm:w-36"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="pi-deduction">Deduction</Label>
              <Input
                id="pi-deduction"
                inputMode="decimal"
                placeholder="0.00"
                className="tabular-nums"
                value={deduction}
                onChange={(e) => setDeduction(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pi-deduction-note">Reason</Label>
              <Input
                id="pi-deduction-note"
                placeholder="Shown on the payslip"
                value={deductionNote}
                onChange={(e) => setDeductionNote(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pi-tax">Income tax</Label>
            <Input
              id="pi-tax"
              inputMode="decimal"
              placeholder="0.00"
              className="tabular-nums sm:w-36"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
            />
          </div>

          <div className="flex items-baseline justify-between rounded-md bg-bg-subtle px-3 py-2">
            <span className="text-sm font-medium">Net pay</span>
            <span className="text-base font-semibold tabular-nums">
              {net === null ? '-' : formatCurrency(net, PAYROLL_CURRENCY)}
            </span>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-state-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
