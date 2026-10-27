'use client';

import { Download, FileUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PayrollImportPreview, PayrollImportPreviewRow, PayrollImportRow } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
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
import { Loader } from '@/components/ui/loader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useImportPayrollSheet, usePreviewPayrollImport } from '@/hooks/use-payroll';
import { formatCurrency } from '@/lib/money';
import { MONTH_NAMES, PAYROLL_CURRENCY, payrollPeriod, payrollYearOptions } from '@/lib/payroll';
import {
  PAYROLL_SHEET_COLUMNS,
  PayrollSheetError,
  payrollTemplateCsv,
  readPayrollSheet,
} from '@/lib/payroll-sheet';
import { saveFile } from '@/lib/save-file';
import { toastError } from '@/lib/toast';

const MATCH_LABELS: Record<NonNullable<PayrollImportPreviewRow['match']>, string> = {
  ON_PAYROLL: 'On payroll',
  PLATFORM_USER: 'Platform user, added to payroll',
  NEW_PERSON: 'New, no platform account',
};

/**
 * Import a month's payroll from a CSV or XLSX sheet. The file is read in the
 * browser, checked by the server (nothing is written), shown row by row, and
 * only imported once every row is clean.
 */
export function ImportSheetDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (runId: string) => void;
}) {
  const previewImport = usePreviewPayrollImport();
  const importSheet = useImportPayrollSheet();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<PayrollImportRow[] | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [period, setPeriod] = useState<{ year: number; month: number } | null>(null);
  const [preview, setPreview] = useState<PayrollImportPreview | null>(null);

  useEffect(() => {
    if (!open) return;
    setFileName(null);
    setRows(null);
    setIgnored([]);
    setReadError(null);
    setPeriod(null);
    setPreview(null);
    previewImport.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset once per open
  }, [open]);

  async function check(sheetRows: PayrollImportRow[], chosen: { year: number; month: number } | null) {
    try {
      const result = await previewImport.mutateAsync({ rows: sheetRows, ...(chosen ?? {}) });
      setPreview(result);
      setPeriod(
        result.year !== null && result.month !== null ? { year: result.year, month: result.month } : chosen,
      );
    } catch {
      setPreview(null);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setReadError(null);
    setPreview(null);
    setRows(null);
    setReading(true);
    try {
      const sheet = await readPayrollSheet(file);
      setRows(sheet.rows);
      setIgnored(sheet.ignoredColumns);
      await check(sheet.rows, null);
    } catch (err) {
      setReadError(err instanceof PayrollSheetError ? err.message : "Couldn't read this file.");
    } finally {
      setReading(false);
      // Choosing the same file again (after fixing it) must fire onChange.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function pickPeriod(next: { year: number; month: number }) {
    setPeriod(next);
    if (rows) void check(rows, next);
  }

  async function downloadTemplate() {
    try {
      await saveFile(payrollTemplateCsv(), 'payroll-template.csv');
    } catch (err) {
      toastError(err, "Couldn't save the template");
    }
  }

  async function submit() {
    if (!rows || !period) return;
    try {
      const result = await importSheet.mutateAsync({ rows, ...period });
      onOpenChange(false);
      onImported(result.run.id);
    } catch {
      // Toast raised by the hook; refresh the preview in case the run changed.
      void check(rows, period);
    }
  }

  const badRows = preview?.rows.filter((r) => r.errors.length > 0).length ?? 0;
  const canImport =
    !!preview && !!period && preview.errors.length === 0 && badRows === 0 && preview.rows.length > 0;
  const now = new Date();
  // Until a month is known, the selects show placeholders, so picking the
  // current month still counts as a choice.
  const fallback = { year: now.getFullYear(), month: now.getMonth() + 1 };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import payroll sheet</DialogTitle>
          <DialogDescription>
            A CSV or Excel (.xlsx) file with one person per row. People are matched to payroll by email, CNIC
            or name; anyone new is added, with or without a platform account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-line bg-bg-subtle px-3 py-2 text-xs text-ink-muted">
            <p>
              Columns:{' '}
              <span className="font-mono text-ink">{PAYROLL_SHEET_COLUMNS.slice(0, 12).join(', ')}</span>
              . Bank columns (<span className="font-mono">{PAYROLL_SHEET_COLUMNS.slice(12).join(', ')}</span>)
              are optional. Only <span className="font-mono">name</span> and{' '}
              <span className="font-mono">basic</span> are required; a blank cell keeps what is saved.
            </p>
            <p className="mt-1">Dates are day first (DD/MM/YYYY). Payment method is bank transfer, cash or cheque.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              id="payroll-sheet-file"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={reading}>
              <FileUp className="h-4 w-4" />
              {fileName ? 'Choose another file' : 'Choose file'}
            </Button>
            <Button variant="ghost" onClick={() => void downloadTemplate()}>
              <Download className="h-4 w-4" /> Template
            </Button>
            {fileName ? (
              <span className="min-w-0 truncate text-sm text-ink-muted" title={fileName}>
                {fileName}
              </span>
            ) : null}
          </div>

          {readError ? (
            <p role="alert" className="text-sm text-state-error">
              {readError}
            </p>
          ) : null}

          {reading || (previewImport.isPending && !preview) ? (
            <div className="flex justify-center py-6">
              <Loader label="Checking the sheet" />
            </div>
          ) : null}

          {rows && (preview || previewImport.isError) ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="import-month">Month</Label>
                  <Select
                    value={period ? String(period.month) : undefined}
                    onValueChange={(v) => pickPeriod({ year: period?.year ?? fallback.year, month: Number(v) })}
                  >
                    <SelectTrigger id="import-month" className="w-40">
                      <SelectValue placeholder="Month" />
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
                  <Label htmlFor="import-year">Year</Label>
                  <Select
                    value={period ? String(period.year) : undefined}
                    onValueChange={(v) => pickPeriod({ year: Number(v), month: period?.month ?? fallback.month })}
                  >
                    <SelectTrigger id="import-year" className="w-28">
                      <SelectValue placeholder="Year" />
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
                {preview && period ? (
                  <p className="pb-2 text-sm text-ink-muted">
                    {preview.run
                      ? `Updates the ${payrollPeriod(period.year, period.month)} run.`
                      : `Creates the ${payrollPeriod(period.year, period.month)} run.`}
                  </p>
                ) : null}
                {previewImport.isPending ? <Loader size="sm" label="Checking" /> : null}
              </div>

              {preview ? (
                <>
                  {preview.errors.map((e) => (
                    <p key={e} role="alert" className="text-sm text-state-error">
                      {e}
                    </p>
                  ))}
                  <p className="text-sm">
                    <span className="font-medium">
                      {preview.rows.length - badRows} of {preview.rows.length} rows ready
                    </span>
                    {badRows > 0 ? (
                      <span className="text-state-error">
                        {' '}
                        · {badRows === 1 ? '1 row needs fixing' : `${badRows} rows need fixing`}
                      </span>
                    ) : null}
                  </p>
                  {preview.notInSheet > 0 ? (
                    <p className="text-xs text-ink-muted">
                      {preview.notInSheet === 1
                        ? '1 person already in this run is not in the sheet and stays as they are.'
                        : `${preview.notInSheet} people already in this run are not in the sheet and stay as they are.`}
                    </p>
                  ) : null}
                  {ignored.length > 0 ? (
                    <p className="text-xs text-ink-muted">Ignored columns: {ignored.join(', ')}</p>
                  ) : null}

                  <div className="max-h-80 overflow-auto rounded-md border border-line">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-bg-surface">
                        <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                          <th className="px-2 py-2 font-medium">Row</th>
                          <th className="px-2 py-2 font-medium">Name</th>
                          <th className="px-2 py-2 font-medium">Match</th>
                          <th className="px-2 py-2 text-right font-medium">Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r) => (
                          <tr key={r.row} className="border-b border-line align-top last:border-0">
                            <td className="px-2 py-2 tabular-nums text-ink-muted">{r.row}</td>
                            <td className="px-2 py-2">
                              <span className="font-medium">{r.name || '-'}</span>
                              {r.errors.length > 0 ? (
                                <ul className="mt-1 space-y-0.5 text-xs text-state-error">
                                  {r.errors.map((e) => (
                                    <li key={e}>{e}</li>
                                  ))}
                                </ul>
                              ) : null}
                            </td>
                            <td className="px-2 py-2">
                              {r.match ? (
                                <Badge tone={r.match === 'NEW_PERSON' ? 'warning' : 'neutral'}>
                                  {MATCH_LABELS[r.match]}
                                  {r.match === 'ON_PAYROLL' && r.matchedBy ? ` (${r.matchedBy})` : ''}
                                </Badge>
                              ) : (
                                '-'
                              )}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {r.net ? formatCurrency(r.net, PAYROLL_CURRENCY) : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canImport || importSheet.isPending || previewImport.isPending}>
            {importSheet.isPending
              ? 'Importing…'
              : preview && canImport
                ? `Import ${preview.rows.length === 1 ? '1 person' : `${preview.rows.length} people`}`
                : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
