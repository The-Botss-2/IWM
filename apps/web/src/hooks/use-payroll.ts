'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError } from '@botss/api-client';
import type {
  AddPayrollEmployeesInput,
  CreatePayrollRunInput,
  PayPayrollRunInput,
  PayrollImportInput,
  PayrollRun,
  SendPayslipsInput,
  SendPayslipsResult,
  UpdatePayrollEmployeeInput,
  UpdatePayrollItemInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { saveFile } from '@/lib/save-file';
import { toast, toastError } from '@/lib/toast';

const payrollStaffKey = ['finance', 'payroll', 'staff'] as const;
const payrollEmployeesKey = ['finance', 'payroll', 'employees'] as const;
const payrollRunsKey = ['finance', 'payroll', 'runs'] as const;
const payrollRunKey = (id: string) => ['finance', 'payroll', 'run', id] as const;

const READ_OPTS = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function usePayrollStaff(enabled = true) {
  return useQuery({
    queryKey: payrollStaffKey,
    queryFn: () => getApi().payroll.staff(),
    enabled,
    ...READ_OPTS,
  });
}

export function usePayrollEmployees() {
  return useQuery({
    queryKey: payrollEmployeesKey,
    queryFn: () => getApi().payroll.employees(),
    ...READ_OPTS,
  });
}

export function usePayrollRuns() {
  return useQuery({
    queryKey: payrollRunsKey,
    queryFn: () => getApi().payroll.runs(),
    ...READ_OPTS,
  });
}

export function usePayrollRun(id: string | null) {
  return useQuery({
    queryKey: payrollRunKey(id ?? ''),
    queryFn: () => getApi().payroll.run(id as string),
    enabled: !!id,
    ...READ_OPTS,
  });
}

function useRosterMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  failMessage: string,
  successMessage: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { successMessage, errorTitle: failMessage },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: payrollEmployeesKey });
      void qc.invalidateQueries({ queryKey: payrollStaffKey });
      // Bank details edited on the roster flow into draft runs.
      void qc.invalidateQueries({ queryKey: ['finance', 'payroll', 'run'] });
    },
  });
}

export function useAddPayrollEmployees() {
  return useRosterMutation(
    (input: AddPayrollEmployeesInput) => getApi().payroll.addEmployees(input),
    "Couldn't add people to payroll",
    'Added to payroll.',
  );
}

export function useUpdatePayrollEmployee() {
  return useRosterMutation(
    ({ id, input }: { id: string; input: UpdatePayrollEmployeeInput }) =>
      getApi().payroll.updateEmployee(id, input),
    "Couldn't save this person",
    'Payroll details saved.',
  );
}

export function useRemovePayrollEmployee() {
  return useRosterMutation(
    (id: string) => getApi().payroll.removeEmployee(id),
    "Couldn't remove this person from payroll",
    'Removed from payroll.',
  );
}

/**
 * Run mutations return the updated run: write it straight into the detail
 * cache and refresh the list totals. Paying or un-paying also changes the
 * expenses and the overview figures.
 */
function useRunMutation<TVars>(
  fn: (vars: TVars) => Promise<PayrollRun>,
  failMessage: string,
  opts: { touchesExpenses?: boolean; success?: string } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (run) => {
      qc.setQueryData(payrollRunKey(run.id), run);
      void qc.invalidateQueries({ queryKey: payrollRunsKey });
      if (opts.touchesExpenses) {
        void qc.invalidateQueries({ queryKey: ['finance', 'expenses'] });
        void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
      }
      if (opts.success) toast.success(opts.success);
    },
    onError: (err) => {
      toastError(err, failMessage);
      refreshAfterConflict(qc, err);
    },
  });
}

/**
 * A 409 or 404 means someone else changed the run: paid it, created the same
 * month, or deleted it. Refetch so this screen stops offering actions that
 * will keep failing.
 */
function refreshAfterConflict(qc: ReturnType<typeof useQueryClient>, err: unknown) {
  if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
    void qc.invalidateQueries({ queryKey: ['finance', 'payroll', 'run'] });
    void qc.invalidateQueries({ queryKey: payrollRunsKey });
  }
}

export function useCreatePayrollRun() {
  return useRunMutation(
    (input: CreatePayrollRunInput) => getApi().payroll.createRun(input),
    "Couldn't create the payroll run",
  );
}

export function useUpdatePayrollItem(runId: string) {
  return useRunMutation(
    ({ itemId, input }: { itemId: string; input: UpdatePayrollItemInput }) =>
      getApi().payroll.updateItem(runId, itemId, input),
    "Couldn't save this line",
  );
}

export function useAddPayrollItem(runId: string) {
  return useRunMutation(
    (employeeId: string) => getApi().payroll.addItem(runId, { employeeId }),
    "Couldn't add this person to the run",
  );
}

export function useRemovePayrollItem(runId: string) {
  return useRunMutation(
    (itemId: string) => getApi().payroll.removeItem(runId, itemId),
    "Couldn't remove this line",
  );
}

export function usePayPayrollRun(runId: string) {
  return useRunMutation(
    (input: PayPayrollRunInput) => getApi().payroll.pay(runId, input),
    "Couldn't mark the payroll as paid",
    {
      touchesExpenses: true,
      success: 'Payroll marked as paid. Salaries are recorded as expenses.',
    },
  );
}

export function useUnpayPayrollRun(runId: string) {
  return useRunMutation(() => getApi().payroll.unpay(runId), "Couldn't undo the payment", {
    touchesExpenses: true,
    success: 'Payment undone. The run can be edited again.',
  });
}

export function useDeletePayrollRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().payroll.deleteRun(id),
    meta: { successMessage: 'Payroll run deleted.' },
    onSuccess: () => void qc.invalidateQueries({ queryKey: payrollRunsKey }),
    onError: (err) => {
      toastError(err, "Couldn't delete the payroll run");
      refreshAfterConflict(qc, err);
    },
  });
}

/** What importing a sheet would do. The dialog shows the problems itself. */
export function usePreviewPayrollImport() {
  return useMutation({
    mutationFn: (input: PayrollImportInput) => getApi().payroll.previewImport(input),
    meta: { errorTitle: "Couldn't check the sheet" },
  });
}

export function useImportPayrollSheet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PayrollImportInput) => getApi().payroll.importSheet(input),
    onSuccess: (result) => {
      qc.setQueryData(payrollRunKey(result.run.id), result.run);
      void qc.invalidateQueries({ queryKey: payrollRunsKey });
      // Imported details reach the roster and other unpaid runs.
      void qc.invalidateQueries({ queryKey: payrollEmployeesKey });
      void qc.invalidateQueries({ queryKey: payrollStaffKey });
      void qc.invalidateQueries({ queryKey: ['finance', 'payroll', 'run'] });
      const people = result.added + result.updated;
      toast.success(`Imported ${people === 1 ? '1 person' : `${people} people`}.`);
    },
    onError: (err) => {
      toastError(err, "Couldn't import the sheet");
      refreshAfterConflict(qc, err);
    },
  });
}

/** Payslips per request: keeps each request well inside the server timeout. */
const SEND_BATCH = 20;

export interface SendPayslipsState {
  status: 'idle' | 'sending' | 'done';
  done: number;
  total: number;
  results: SendPayslipsResult['results'];
  /** Lines never attempted because sending stopped early. */
  pending: string[];
  /** Each line's payslipSentAt (ms) when sending started, to spot what went out. */
  before: Map<string, number | null>;
  /** Why sending stopped (wrong password, server unreachable). */
  error: unknown;
}

const IDLE: SendPayslipsState = {
  status: 'idle',
  done: 0,
  total: 0,
  results: [],
  pending: [],
  before: new Map(),
  error: null,
};

/**
 * Email payslips in batches, so a large team shows progress and no single
 * request runs long. The mailbox login goes with every batch and is never
 * kept beyond the call. A login or connection failure stops the remaining
 * batches; one person's failed message does not.
 */
export function useSendPayslips(runId: string) {
  const qc = useQueryClient();
  const [state, setState] = useState<SendPayslipsState>(IDLE);

  const send = useCallback(
    async (
      login: Omit<SendPayslipsInput, 'itemIds'>,
      itemIds: string[],
      before: Map<string, number | null>,
    ) => {
      const results: SendPayslipsResult['results'] = [];
      setState({
        status: 'sending',
        done: 0,
        total: itemIds.length,
        results,
        pending: [],
        before,
        error: null,
      });
      let i = 0;
      try {
        for (; i < itemIds.length; i += SEND_BATCH) {
          const batch = itemIds.slice(i, i + SEND_BATCH);
          const res = await getApi().payroll.sendPayslips(runId, { ...login, itemIds: batch });
          results.push(...res.results);
          setState((s) => ({ ...s, done: i + batch.length, results: [...results] }));
        }
        setState((s) => ({ ...s, status: 'done' }));
      } catch (err) {
        // The batch that failed and everything after it. A batch stopped by
        // a rejected login may have sent some payslips first: the server
        // marks those, and the dialog compares against `before` to skip them.
        const pending = itemIds.slice(i);
        setState((s) => ({
          ...s,
          status: results.length > 0 ? 'done' : 'idle',
          pending,
          error: err,
        }));
      } finally {
        void qc.invalidateQueries({ queryKey: payrollRunKey(runId) });
      }
    },
    [qc, runId],
  );

  const reset = useCallback(() => setState(IDLE), []);
  return { ...state, send, reset };
}

/**
 * Payslips and the bank CSV come back as bytes through the API (not object
 * storage links), so they download the same way in the browser, the desktop
 * app and the mobile WebView.
 */
function useDownload<TVars>(
  fn: (vars: TVars) => Promise<{ blob: Blob; filename: string | null }>,
  fallbackName: (vars: TVars) => string,
  failMessage: string,
) {
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const { blob, filename } = await fn(vars);
      await saveFile(blob, filename ?? fallbackName(vars));
    },
    meta: { errorTitle: failMessage },
  });
}

export function useDownloadPayslips() {
  return useDownload(
    (runId: string) => getApi().payroll.payslipsPdf(runId),
    () => 'payslips.pdf',
    "Couldn't generate the payslips",
  );
}

export function useDownloadPayslip() {
  return useDownload(
    ({ runId, itemId }: { runId: string; itemId: string }) =>
      getApi().payroll.payslipPdf(runId, itemId),
    () => 'payslip.pdf',
    "Couldn't generate this payslip",
  );
}

export function useDownloadBankCsv() {
  return useDownload(
    (runId: string) => getApi().payroll.bankTransferCsv(runId),
    () => 'bank-transfer.csv',
    "Couldn't export the bank transfer list",
  );
}
