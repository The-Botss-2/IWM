/**
 * Reading a payroll sheet (CSV or XLSX) in the browser into the rows the
 * import API takes. Only the reading happens here: every cell goes up as
 * text and the server parses, validates and matches it, so the rules live in
 * one place (apps/api/src/payroll/payroll-import.ts).
 */
import type { PayrollImportRow } from '@botss/shared-types';

type Field = Exclude<keyof PayrollImportRow, 'row'>;

/** The template's columns, in order. Bank columns are optional extras. */
export const PAYROLL_SHEET_COLUMNS = [
  'name',
  'designation',
  'doj',
  'month',
  'cnic',
  'basic',
  'bonus',
  'deduction',
  'commission',
  'tax',
  'payment_method',
  'email',
  'bank_name',
  'account_title',
  'account_number',
] as const;

/** Header spellings people use, after `headerKey` normalization. */
const ALIASES: Record<Field, string[]> = {
  name: ['name', 'employee name', 'employee', 'full name', 'staff name'],
  designation: ['designation', 'job title', 'position', 'role'],
  doj: ['doj', 'date of joining', 'joining date', 'date joined', 'join date'],
  month: ['month', 'pay month', 'salary month', 'pay period', 'period'],
  cnic: ['cnic', 'cnic no', 'cnic number', 'nic', 'id card'],
  basic: ['basic', 'basic salary', 'basic pay'],
  bonus: ['bonus', 'bonuses'],
  deduction: ['deduction', 'deductions'],
  commission: ['commission', 'commissions'],
  tax: ['tax', 'income tax', 'withholding tax', 'wht'],
  paymentMethod: ['payment method', 'payment mode', 'mode of payment', 'method'],
  email: ['email', 'email address', 'e mail', 'mail'],
  bankName: ['bank name', 'bank'],
  accountTitle: ['account title', 'title of account'],
  accountNumber: ['account number', 'account no', 'account', 'iban', 'account number iban'],
};

const FIELD_BY_HEADER = new Map<string, Field>(
  (Object.entries(ALIASES) as [Field, string[]][]).flatMap(([field, names]) =>
    names.map((n) => [n, field] as const),
  ),
);

const MAX_ROWS = 500;
const MAX_BYTES = 5 * 1024 * 1024;

export interface PayrollSheet {
  rows: PayrollImportRow[];
  /** Headers that matched no field; their cells are ignored. */
  ignoredColumns: string[];
}

export class PayrollSheetError extends Error {}

/** "Payment_Method", "CNIC #" and "payment method" all become "payment method" / "cnic". */
function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A cell as text. Excel date cells become "YYYY-MM-DD" (they are UTC dates). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/** RFC 4180 CSV, with the delimiter (comma, semicolon or tab) taken from the header line. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Turn a grid (header row first) into import rows keyed by field. */
export function sheetFromGrid(grid: unknown[][]): PayrollSheet {
  const isBlank = (r: unknown[]) => r.every((c) => cellText(c) === '');
  const headerIndex = grid.findIndex((r) => !isBlank(r));
  if (headerIndex < 0) throw new PayrollSheetError('The file is empty.');

  const header = grid[headerIndex]!.map((c) => cellText(c));
  // The first column for a field wins; a second one ("Designation" and
  // "Role") is ignored rather than silently overwriting it.
  const taken = new Set<Field>();
  const columns = header.map((h) => {
    const field = FIELD_BY_HEADER.get(headerKey(h)) ?? null;
    if (!field || taken.has(field)) return null;
    taken.add(field);
    return field;
  });
  const ignoredColumns = header.filter((h, i) => h !== '' && columns[i] === null);
  const missing = (['name', 'basic'] as const).filter((f) => !columns.includes(f));
  if (missing.length > 0) {
    throw new PayrollSheetError(
      `The sheet needs a ${missing.join(' and a ')} column. Download the template to see the layout.`,
    );
  }

  const rows: PayrollImportRow[] = [];
  for (let i = headerIndex + 1; i < grid.length; i += 1) {
    const cells = grid[i]!;
    if (isBlank(cells)) continue;
    // Row numbers as the spreadsheet shows them (1-based).
    const row: PayrollImportRow = { row: i + 1 };
    columns.forEach((field, c) => {
      if (!field) return;
      const value = cellText(cells[c]).slice(0, 300);
      if (value !== '') row[field] = value;
    });
    rows.push(row);
  }
  if (rows.length === 0) throw new PayrollSheetError('The sheet has a header but no people.');
  if (rows.length > MAX_ROWS) {
    throw new PayrollSheetError(`The sheet has ${rows.length} people; import at most ${MAX_ROWS} at a time.`);
  }
  return { rows, ignoredColumns };
}

/** Read a .csv or .xlsx file (the first sheet of a workbook). */
export async function readPayrollSheet(file: File): Promise<PayrollSheet> {
  if (file.size > MAX_BYTES) throw new PayrollSheetError('The file is larger than 5 MB.');
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return sheetFromGrid(parseCsv(await file.text()));
  }
  if (name.endsWith('.xlsx')) {
    // Loaded on demand: only this dialog needs it.
    const { readSheet } = await import('read-excel-file/browser');
    let grid: unknown[][];
    try {
      grid = await readSheet(file);
    } catch {
      throw new PayrollSheetError("Couldn't read this Excel file. Save it again as .xlsx or .csv.");
    }
    return sheetFromGrid(grid);
  }
  if (name.endsWith('.xls')) {
    throw new PayrollSheetError('Old .xls files are not supported. Save the sheet as .xlsx or .csv.');
  }
  throw new PayrollSheetError('Choose a .csv or .xlsx file.');
}

/** The empty template, as CSV with a BOM so Excel opens it as UTF-8. */
export function payrollTemplateCsv(): Blob {
  return new Blob([`﻿${PAYROLL_SHEET_COLUMNS.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' });
}
