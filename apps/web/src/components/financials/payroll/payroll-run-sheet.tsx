'use client';

import { Download, FileSpreadsheet, Mail, Trash2, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PayrollEmployee, PayrollItem } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  useAddPayrollItem,
  useDeletePayrollRun,
  useDownloadBankCsv,
  useDownloadPayslip,
  useDownloadPayslips,
  usePayrollRun,
  useRemovePayrollItem,
  useUnpayPayrollRun,
} from '@/hooks/use-payroll';
import { formatCurrency } from '@/lib/money';
import { PAYMENT_METHOD_LABELS, PAYROLL_CURRENCY, payrollPeriod } from '@/lib/payroll';

import { MarkPaidDialog } from './mark-paid-dialog';
import { PayrollItemDialog } from './payroll-item-dialog';
import { SendPayslipsDialog } from './send-payslips-dialog';

const pkr = (v: string | number) => formatCurrency(v, PAYROLL_CURRENCY);
/** An optional amount: a dash when zero, so the real figures stand out. */
const pkrOrDash = (v: string) => (Number(v) > 0 ? pkr(v) : '-');
/** "2024-03-01" as "01/03/2024", the way dates are written in the team. */
const dmy = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '-');

/** One month's payroll: the lines, the totals, the documents and the payment. */
export function PayrollRunSheet({
  runId,
  onOpenChange,
  employees,
  baseCurrency,
}: {
  runId: string | null;
  onOpenChange: (open: boolean) => void;
  employees: PayrollEmployee[];
  baseCurrency: string | null;
}) {
  const runQuery = usePayrollRun(runId);
  const run = runQuery.data;
  const id = runId ?? '';
  const addItem = useAddPayrollItem(id);
  const removeItem = useRemovePayrollItem(id);
  const unpay = useUnpayPayrollRun(id);
  const deleteRun = useDeletePayrollRun();
  const payslips = useDownloadPayslips();
  const payslip = useDownloadPayslip();
  const bankCsv = useDownloadBankCsv();

  const [editing, setEditing] = useState<PayrollItem | null>(null);
  const [removing, setRemoving] = useState<PayrollItem | null>(null);
  const [paying, setPaying] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [confirmUnpay, setConfirmUnpay] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isDraft = run?.status === 'DRAFT';

  const addable = useMemo(() => {
    const inRun = new Set(run?.items.map((i) => i.employeeId) ?? []);
    return employees
      .filter((e) => !inRun.has(e.id))
      .map((e) => ({ value: e.id, label: e.name, description: pkr(e.monthlySalary) }));
  }, [employees, run]);

  return (
    <>
      <Sheet open={!!runId} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-6xl">
          <SheetHeader>
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle className="text-lg font-semibold">
                {run ? `${payrollPeriod(run.year, run.month)} payroll` : 'Payroll'}
              </SheetTitle>
              {run ? (
                run.status === 'PAID' ? (
                  <Badge tone="success">
                    Paid{run.paidAt ? ` on ${new Date(run.paidAt).toLocaleDateString()}` : ''}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not paid yet</Badge>
                )
              ) : null}
            </div>
            <SheetDescription className="text-sm text-ink-muted">
              {run
                ? run.status === 'PAID'
                  ? `Salaries are recorded as expenses${run.paymentSource ? `, paid from ${run.paymentSource.name}` : ''}.`
                  : 'Adjust bonuses, commission, deductions and tax, then mark it paid.'
                : 'Loading'}
            </SheetDescription>
          </SheetHeader>

          <SheetBody className="space-y-5">
            {runQuery.isLoading ? (
              <div className="flex justify-center py-10">
                <Loader label="Loading payroll" />
              </div>
            ) : runQuery.isError || !run ? (
              <QueryError message="Couldn't load this payroll run." onRetry={() => void runQuery.refetch()} />
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {(
                    [
                      ['Basic', run.totalSalary],
                      ['Bonuses', run.totalBonus],
                      ['Commission', run.totalCommission],
                      ['Deductions', run.totalDeduction],
                      ['Tax', run.totalTax],
                      ['Net pay', run.totalNet],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-md border border-line px-3 py-2">
                      <dt className="text-xs text-ink-muted">{label}</dt>
                      <dd
                        className={
                          label === 'Net pay'
                            ? 'text-base font-semibold tabular-nums'
                            : 'text-sm font-medium tabular-nums'
                        }
                      >
                        {pkr(value)}
                      </dd>
                    </div>
                  ))}
                </dl>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => payslips.mutate(run.id)}
                    disabled={payslips.isPending || run.items.length === 0}
                  >
                    <Download className="h-4 w-4" />
                    {payslips.isPending ? 'Preparing…' : 'All payslips (PDF)'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => bankCsv.mutate(run.id)}
                    disabled={bankCsv.isPending || run.items.length === 0}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    Bank transfer CSV
                  </Button>
                  {!isDraft ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setEmailing(true)}
                      disabled={run.items.length === 0}
                    >
                      <Mail className="h-4 w-4" />
                      Email payslips
                    </Button>
                  ) : null}
                  {isDraft && addable.length > 0 ? (
                    <div className="w-full sm:ml-auto sm:w-56">
                      <Combobox
                        options={addable}
                        value={null}
                        onChange={(employeeId) => {
                          if (employeeId) addItem.mutate(employeeId);
                        }}
                        placeholder="Add a person"
                        searchPlaceholder="Search payroll"
                        emptyText="Everyone is in this run."
                        disabled={addItem.isPending}
                      />
                    </div>
                  ) : null}
                </div>

                {run.items.length === 0 ? (
                  <p className="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
                    Nobody is in this run.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                          <th className="px-2 py-2 font-medium">Name</th>
                          <th className="px-2 py-2 font-medium">Designation</th>
                          <th className="px-2 py-2 font-medium">DOJ</th>
                          <th className="px-2 py-2 font-medium">Month</th>
                          <th className="px-2 py-2 font-medium">CNIC</th>
                          <th className="px-2 py-2 text-right font-medium">Basic</th>
                          <th className="px-2 py-2 text-right font-medium">Bonus</th>
                          <th className="px-2 py-2 text-right font-medium">Deduction</th>
                          <th className="px-2 py-2 text-right font-medium">Commission</th>
                          <th className="px-2 py-2 text-right font-medium">Tax</th>
                          <th className="px-2 py-2 font-medium">Payment</th>
                          <th className="px-2 py-2 font-medium">Email</th>
                          <th className="px-2 py-2 text-right font-medium">Net</th>
                          <th className="px-2 py-2">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.items.map((item) => (
                          <tr key={item.id} className="whitespace-nowrap border-b border-line last:border-0">
                            <td className="px-2 py-2">
                              {isDraft ? (
                                <button
                                  type="button"
                                  className="text-left font-medium hover:underline"
                                  onClick={() => setEditing(item)}
                                >
                                  {item.employeeName}
                                </button>
                              ) : (
                                <span className="font-medium">{item.employeeName}</span>
                              )}
                            </td>
                            <td className="px-2 py-2 text-ink-muted">{item.designation ?? '-'}</td>
                            <td className="px-2 py-2 tabular-nums text-ink-muted">{dmy(item.dateOfJoining)}</td>
                            <td className="px-2 py-2 text-ink-muted">{payrollPeriod(run.year, run.month)}</td>
                            <td className="px-2 py-2 tabular-nums text-ink-muted">{item.cnic ?? '-'}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{pkr(item.salary)}</td>
                            <td className="px-2 py-2 text-right tabular-nums" title={item.bonusNote ?? undefined}>
                              {pkrOrDash(item.bonus)}
                            </td>
                            <td
                              className="px-2 py-2 text-right tabular-nums"
                              title={item.deductionNote ?? undefined}
                            >
                              {pkrOrDash(item.deduction)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{pkrOrDash(item.commission)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{pkrOrDash(item.tax)}</td>
                            <td className="px-2 py-2">
                              {PAYMENT_METHOD_LABELS[item.paymentMethod]}
                              {item.paymentMethod === 'BANK_TRANSFER' && !item.accountNumber ? (
                                <span className="block text-xs text-state-warning">No bank account</span>
                              ) : null}
                            </td>
                            <td className="px-2 py-2">
                              {item.email ? (
                                <span className="text-ink-muted">{item.email}</span>
                              ) : (
                                <span className="text-state-warning">No email</span>
                              )}
                              {item.payslipSentAt ? (
                                <span
                                  className="block text-xs text-brand-teal"
                                  title={`Sent to ${item.payslipSentTo ?? ''} on ${new Date(item.payslipSentAt).toLocaleString()}`}
                                >
                                  Payslip emailed
                                </span>
                              ) : null}
                            </td>
                            <td className="px-2 py-2 text-right font-medium tabular-nums">{pkr(item.net)}</td>
                            <td className="px-2 py-2">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Download payslip for ${item.employeeName}`}
                                  title="Download payslip"
                                  disabled={payslip.isPending}
                                  onClick={() => payslip.mutate({ runId: run.id, itemId: item.id })}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                                {isDraft ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${item.employeeName} from this run`}
                                    title="Remove from this run"
                                    onClick={() => setRemoving(item)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </SheetBody>

          {run ? (
            <SheetFooter className="justify-between">
              {isDraft ? (
                <>
                  <Button variant="ghost" className="text-state-error" onClick={() => setConfirmDelete(true)}>
                    Delete run
                  </Button>
                  <Button onClick={() => setPaying(true)} disabled={run.items.length === 0}>
                    Mark as paid
                  </Button>
                </>
              ) : (
                <Button variant="secondary" className="ml-auto" onClick={() => setConfirmUnpay(true)}>
                  <Undo2 className="h-4 w-4" /> Undo payment
                </Button>
              )}
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>

      {run ? (
        <>
          <PayrollItemDialog runId={run.id} item={editing} onOpenChange={(o) => !o && setEditing(null)} />
          <MarkPaidDialog run={run} open={paying} onOpenChange={setPaying} baseCurrency={baseCurrency} />
          {run.status === 'PAID' ? (
            <SendPayslipsDialog run={run} open={emailing} onOpenChange={setEmailing} />
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.employeeName ?? 'this person'} from this run?`}
        description="They stay on payroll for future months."
        confirmLabel="Remove"
        variant="destructive"
        pending={removeItem.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeItem.mutateAsync(removing.id);
            setRemoving(null);
          } catch {
            // Toast raised by the hook.
          }
        }}
      />
      <ConfirmDialog
        open={confirmUnpay}
        onOpenChange={setConfirmUnpay}
        title="Undo this payment?"
        description="The salary expenses recorded for this month are removed and the run can be edited again."
        confirmLabel="Undo payment"
        pending={unpay.isPending}
        onConfirm={async () => {
          try {
            await unpay.mutateAsync(undefined);
            setConfirmUnpay(false);
          } catch {
            // Toast raised by the hook.
          }
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this payroll run?"
        description="Nothing has been paid from it. You can create the month again later."
        confirmLabel="Delete"
        variant="destructive"
        pending={deleteRun.isPending}
        onConfirm={async () => {
          if (!run) return;
          try {
            await deleteRun.mutateAsync(run.id);
            setConfirmDelete(false);
            onOpenChange(false);
          } catch {
            // Toast raised by the hook.
          }
        }}
      />
    </>
  );
}
