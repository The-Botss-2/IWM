'use client';

import { useEffect, useState } from 'react';
import type { PayrollRunSummary } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreatePayrollRun } from '@/hooks/use-payroll';
import { MONTH_NAMES, payrollPeriod, payrollYearOptions } from '@/lib/payroll';

/** Start a month's payroll, pre-filled with everyone active on payroll. */
export function NewRunDialog({
  open,
  onOpenChange,
  existing,
  activePeople,
  onCreated,
  onOpenExisting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: PayrollRunSummary[];
  activePeople: number;
  onCreated: (runId: string) => void;
  onOpenExisting: (runId: string) => void;
}) {
  const create = useCreatePayrollRun();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);

  useEffect(() => {
    if (!open) return;
    const now = new Date();
    setYear(now.getFullYear());
    setMonth(now.getMonth() + 1);
  }, [open]);

  const clash = existing.find((r) => r.year === year && r.month === month) ?? null;

  async function submit() {
    try {
      const run = await create.mutateAsync({ year, month });
      onOpenChange(false);
      onCreated(run.id);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New payroll run</DialogTitle>
          <DialogDescription>
            {activePeople === 1
              ? 'The run starts with the 1 person on payroll and their monthly salary.'
              : `The run starts with the ${activePeople} people on payroll and their monthly salaries.`}{' '}
            You can add bonuses and deductions before marking it paid.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="run-month">Month</Label>
            <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
              <SelectTrigger id="run-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, i) => (
                  <SelectItem key={name} value={String(i + 1)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-year">Year</Label>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger id="run-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {payrollYearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {clash ? (
          <p className="text-ink-muted text-sm" role="status">
            {payrollPeriod(year, month)} already has a payroll run.{' '}
            <button
              type="button"
              className="text-ink font-medium underline underline-offset-2"
              onClick={() => {
                onOpenChange(false);
                onOpenExisting(clash.id);
              }}
            >
              Open it
            </button>
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!!clash || activePeople === 0 || create.isPending}
          >
            {create.isPending ? 'Creating…' : `Create ${payrollPeriod(year, month)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
