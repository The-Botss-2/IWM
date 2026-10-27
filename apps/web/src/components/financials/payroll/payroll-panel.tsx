'use client';

import { CalendarPlus, ChevronRight, FileUp } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { PayrollEmployee } from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { usePayrollEmployees, usePayrollRuns } from '@/hooks/use-payroll';
import { formatCurrency } from '@/lib/money';
import { PAYMENT_METHOD_LABELS, PAYROLL_CURRENCY, payrollPeriod, sumAmounts } from '@/lib/payroll';

import { AddPeopleDialog } from './add-people-dialog';
import { EmployeeDialog } from './employee-dialog';
import { ImportSheetDialog } from './import-sheet-dialog';
import { NewRunDialog } from './new-run-dialog';
import { PayrollRunSheet } from './payroll-run-sheet';

const pkr = (v: string) => formatCurrency(v, PAYROLL_CURRENCY);

/**
 * The Payroll tab: monthly runs on top (the thing used every month), the
 * people on payroll below (set up once, edited occasionally).
 */
export function PayrollPanel({
  addOpen,
  onAddOpenChange,
  baseCurrency,
}: {
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  /** Null while the reporting currency is loading. */
  baseCurrency: string | null;
}) {
  const employees = usePayrollEmployees();
  const runs = usePayrollRuns();
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PayrollEmployee | null>(null);

  const roster = employees.data?.items ?? [];
  const active = roster.filter((e) => e.isActive);
  const monthlyTotal = sumAmounts(active.map((e) => e.monthlySalary));

  return (
    <div className="space-y-8">
      <section aria-labelledby="payroll-runs-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="payroll-runs-heading" className="text-base font-semibold">
              Payroll runs
            </h2>
            <p className="text-sm text-ink-muted">One per month. Paying a run records the salaries as expenses.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <FileUp className="h-4 w-4" /> Import sheet
            </Button>
            <Button variant="secondary" onClick={() => setNewRunOpen(true)} disabled={active.length === 0}>
              <CalendarPlus className="h-4 w-4" /> New payroll run
            </Button>
          </div>
        </div>

        {runs.isLoading ? (
          <ListSkeleton />
        ) : runs.isError ? (
          <QueryError message="Couldn't load payroll runs." onRetry={() => void runs.refetch()} />
        ) : (runs.data?.items.length ?? 0) === 0 ? (
          <Empty>
            {active.length === 0
              ? 'Add people to payroll, or import a sheet with the month’s salaries.'
              : 'No payroll runs yet. Start one for this month.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-bg-surface" role="list">
            {runs.data!.items.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenRunId(r.id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-bg-subtle focus-visible:bg-bg-subtle focus-visible:outline-none"
                >
                  <span className="min-w-[9rem] font-medium">{payrollPeriod(r.year, r.month)}</span>
                  {r.status === 'PAID' ? (
                    <Badge tone="success">Paid</Badge>
                  ) : (
                    <Badge tone="neutral">Not paid yet</Badge>
                  )}
                  <span className="text-sm text-ink-muted">
                    {r.people === 1 ? '1 person' : `${r.people} people`}
                  </span>
                  <span className="ml-auto font-medium tabular-nums">{pkr(r.totalNet)}</span>
                  <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="payroll-people-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="payroll-people-heading" className="text-base font-semibold">
              People on payroll
            </h2>
            <p className="text-sm text-ink-muted">
              {active.length === 0
                ? 'Nobody yet.'
                : `${active.length === 1 ? '1 person' : `${active.length} people`}, ${pkr(monthlyTotal)} a month.`}
            </p>
          </div>
        </div>

        {employees.isLoading ? (
          <ListSkeleton />
        ) : employees.isError ? (
          <QueryError message="Couldn't load people on payroll." onRetry={() => void employees.refetch()} />
        ) : roster.length === 0 ? (
          <Empty>
            Add the people you pay each month from your team, or import a sheet: people without a platform
            account are added from it too.
          </Empty>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Designation</th>
                    <th className="px-3 py-2 font-medium">Payment</th>
                    <th className="px-3 py-2 text-right font-medium">Monthly salary</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((e) => (
                    <tr
                      key={e.id}
                      className="cursor-pointer border-b border-line last:border-0 hover:bg-bg-subtle"
                      onClick={() => setEditing(e)}
                    >
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="flex items-center gap-2 text-left"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setEditing(e);
                          }}
                        >
                          <UserAvatar size="sm" name={e.name || e.email || '?'} image={e.image} />
                          <span>
                            <span className="block font-medium">{e.name}</span>
                            <span className="block text-xs text-ink-muted">
                              {e.email ?? 'No email'}
                              {!e.userId ? ' · no platform account' : ''}
                            </span>
                          </span>
                          {!e.isActive ? <Badge tone="neutral">Paused</Badge> : null}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-ink-muted">{e.designation ?? '-'}</td>
                      <td className="px-3 py-2">
                        {e.paymentMethod !== 'BANK_TRANSFER' ? (
                          <span className="text-ink-muted">{PAYMENT_METHOD_LABELS[e.paymentMethod]}</span>
                        ) : e.accountNumber ? (
                          <span className="text-ink-muted">{e.bankName ?? 'Bank account added'}</span>
                        ) : (
                          <span className="text-state-warning">Add bank details</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{pkr(e.monthlySalary)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="space-y-2 md:hidden" role="list">
              {roster.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setEditing(e)}
                    className="flex w-full items-center gap-3 rounded-md border border-line bg-bg-surface p-3 text-left"
                  >
                    <UserAvatar size="sm" name={e.name || e.email || '?'} image={e.image} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{e.name}</span>
                      <span className="block truncate text-xs text-ink-muted">
                        {e.designation ?? e.email ?? PAYMENT_METHOD_LABELS[e.paymentMethod]}
                        {e.paymentMethod === 'BANK_TRANSFER' && !e.accountNumber ? ' · no bank details' : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block font-medium tabular-nums">{pkr(e.monthlySalary)}</span>
                      {!e.isActive ? <span className="block text-xs text-ink-muted">Paused</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <AddPeopleDialog open={addOpen} onOpenChange={onAddOpenChange} />
      <EmployeeDialog employee={editing} onOpenChange={(o) => !o && setEditing(null)} />
      <ImportSheetDialog open={importOpen} onOpenChange={setImportOpen} onImported={setOpenRunId} />
      <NewRunDialog
        open={newRunOpen}
        onOpenChange={setNewRunOpen}
        existing={runs.data?.items ?? []}
        activePeople={active.length}
        onCreated={setOpenRunId}
        onOpenExisting={setOpenRunId}
      />
      <PayrollRunSheet
        runId={openRunId}
        onOpenChange={(o) => !o && setOpenRunId(null)}
        employees={active}
        baseCurrency={baseCurrency}
      />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-bg-surface p-8 text-center text-sm text-ink-muted">
      {children}
    </div>
  );
}
