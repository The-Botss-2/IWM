'use client';

import { Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { addPayrollEmployeesSchema } from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
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
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useAddPayrollEmployees, usePayrollStaff } from '@/hooks/use-payroll';
import { payrollAmount } from '@/lib/payroll';
import { cn } from '@/lib/utils';

/**
 * Pick people from the whole staff list and give each a monthly salary.
 * People already on payroll are shown but can't be picked again; their
 * salary is changed from the roster instead.
 */
export function AddPeopleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const staff = usePayrollStaff(open);
  const add = useAddPayrollEmployees();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelected(new Map());
    setError(null);
  }, [open]);

  const people = useMemo(() => {
    const term = search.trim().toLowerCase();
    const all = staff.data?.items ?? [];
    if (!term) return all;
    return all.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(term));
  }, [staff.data, search]);

  const nameOf = useMemo(
    () => new Map((staff.data?.items ?? []).map((p) => [p.id, p.name || p.email])),
    [staff.data],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, '');
      return next;
    });
  }

  function setSalary(id: string, value: string) {
    setSelected((prev) => new Map(prev).set(id, value));
  }

  async function submit() {
    setError(null);
    const rows: Array<{ userId: string; monthlySalary: string }> = [];
    for (const [userId, raw] of selected) {
      const amount = payrollAmount(raw);
      if (raw.trim() === '' || amount === null || Number(amount) <= 0) {
        setError(`Enter a monthly salary for ${nameOf.get(userId) ?? 'everyone selected'}.`);
        return;
      }
      rows.push({ userId, monthlySalary: amount });
    }
    const parsed = addPayrollEmployeesSchema.safeParse({ people: rows });
    if (!parsed.success) {
      setError('Select at least one person.');
      return;
    }
    try {
      await add.mutateAsync(parsed.data);
      onOpenChange(false);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add people to payroll</DialogTitle>
          <DialogDescription>
            Select people and enter the monthly salary (PKR) each one is paid. Bank details can be added
            afterwards from the list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search people"
          />
          <ul
            role="listbox"
            aria-multiselectable
            aria-label="Staff"
            className="max-h-64 space-y-1 overflow-y-auto"
          >
            {staff.isLoading ? (
              <li role="presentation" className="flex justify-center px-2 py-6">
                <Loader size="sm" label="Loading people" />
              </li>
            ) : staff.isError && !staff.data ? (
              <li role="presentation" className="px-2 py-2">
                <QueryError
                  compact
                  message="Couldn't load people."
                  onRetry={() => void staff.refetch()}
                />
              </li>
            ) : people.length === 0 ? (
              <li role="presentation" className="px-2 py-6 text-center text-sm text-ink-muted">
                Nobody matches that search.
              </li>
            ) : (
              people.map((p) => {
                const onPayroll = !!p.payrollEmployeeId;
                const active = selected.has(p.id);
                return (
                  <li key={p.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-disabled={onPayroll}
                      disabled={onPayroll}
                      onClick={() => toggle(p.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                        onPayroll
                          ? 'cursor-default opacity-60'
                          : active
                            ? 'bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20'
                            : 'hover:bg-bg-subtle',
                      )}
                    >
                      <UserAvatar size="sm" name={p.name || p.email} image={p.image} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{p.name || p.email}</span>
                        <span className="block truncate text-xs text-ink-muted">{p.email}</span>
                      </span>
                      {onPayroll ? (
                        <span className="shrink-0 text-xs text-ink-muted">On payroll</span>
                      ) : active ? (
                        <Check className="h-4 w-4 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {selected.size > 0 ? (
            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                Monthly salary (PKR)
              </p>
              {[...selected.entries()].map(([id, value]) => {
                const inputId = `salary-${id}`;
                return (
                  <div key={id} className="flex items-center gap-3">
                    <Label htmlFor={inputId} className="min-w-0 flex-1 truncate text-sm font-normal">
                      {nameOf.get(id)}
                    </Label>
                    <Input
                      id={inputId}
                      className="w-40 text-right tabular-nums"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={value}
                      onChange={(e) => setSalary(id, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

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
          <Button onClick={() => void submit()} disabled={add.isPending || selected.size === 0}>
            {add.isPending
              ? 'Adding…'
              : selected.size > 1
                ? `Add ${selected.size} people`
                : 'Add to payroll'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
