/**
 * The payroll sheet import, as pure functions: read each cell of a CSV/XLSX
 * row, then match the row to a person. No database access here, so
 * check-payroll.ts can exercise every rule; PayrollService loads the roster
 * and staff, calls `planImport`, and writes the result.
 *
 * Every problem is collected per row (and per sheet) rather than thrown, so
 * the preview can show all of them at once.
 */
import type {
  PayrollImportMatch,
  PayrollImportRow,
  PayrollPaymentMethod,
} from '@botss/shared-types';

import { D, type Decimal } from '../finance/serialize';
import { netOrNull, periodLabel, readAmount } from './payroll-math';

/** A person already on payroll, as matching needs them. */
export interface RosterPerson {
  id: string;
  userId: string | null;
  name: string;
  /** The effective payslip email (own, else the account's). */
  email: string | null;
  cnic: string | null;
}

/** A platform staff member of the organization. */
export interface StaffMember {
  id: string;
  name: string;
  email: string;
}

/** The adjustable amounts of a month's line (salary always comes from the sheet). */
export interface LineExtras {
  bonus: Decimal;
  commission: Decimal;
  deduction: Decimal;
  tax: Decimal;
}

/**
 * One row's values. A field left `undefined` was blank in the sheet: the
 * person's saved value is kept (for an amount, the one on their line this
 * month). New people get null, or 0 for an amount.
 */
export interface ImportValues {
  name: string | undefined;
  designation: string | undefined;
  dateOfJoining: Date | undefined;
  cnic: string | undefined;
  paymentMethod: PayrollPaymentMethod | undefined;
  email: string | undefined;
  bankName: string | undefined;
  accountTitle: string | undefined;
  accountNumber: string | undefined;
  salary: Decimal;
  bonus: Decimal | undefined;
  commission: Decimal | undefined;
  deduction: Decimal | undefined;
  tax: Decimal | undefined;
  /** Net as it will be written, with blank amounts taken from the saved line. */
  net: Decimal;
}

/** A row's amounts with blanks filled from the person's saved line, or 0. */
export function resolveAmounts(values: ImportValues, saved: LineExtras | undefined) {
  const zero = new D(0);
  return {
    salary: values.salary,
    bonus: values.bonus ?? saved?.bonus ?? zero,
    commission: values.commission ?? saved?.commission ?? zero,
    deduction: values.deduction ?? saved?.deduction ?? zero,
    tax: values.tax ?? saved?.tax ?? zero,
  };
}

export type ImportTarget =
  | { match: 'ON_PAYROLL'; employeeId: string }
  | { match: 'PLATFORM_USER'; userId: string }
  | { match: 'NEW_PERSON' };

export interface PlannedRow {
  row: number;
  name: string;
  match: PayrollImportMatch | null;
  matchedBy: 'email' | 'cnic' | 'name' | null;
  inRun: boolean;
  errors: string[];
  /** Set only when the row has no errors. */
  values: ImportValues | null;
  target: ImportTarget | null;
}

export interface ImportPlan {
  year: number | null;
  month: number | null;
  rows: PlannedRow[];
  errors: string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Collapse spaces and lowercase, for comparing names. */
export function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** "35202-1234567-1" from any 13 digits with optional dashes or spaces. */
export function parseCnic(value: string): string | null {
  if (!/^[\d\s-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 13) return null;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

/** Bank transfer, cash or cheque, from the ways people write them. */
export function parsePaymentMethod(value: string): PayrollPaymentMethod | null {
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  if (['bank', 'banktransfer', 'transfer', 'ibft', 'ift', 'online', 'onlinetransfer', 'bankaccount', 'wire', 'wiretransfer'].includes(key)) {
    return 'BANK_TRANSFER';
  }
  if (key === 'cash') return 'CASH';
  if (['cheque', 'check', 'chq', 'bankcheque', 'bankcheck'].includes(key)) return 'CHEQUE';
  return null;
}

function monthIndex(word: string): number | null {
  const i = MONTHS.indexOf(word.toLowerCase().slice(0, 3));
  // "Sept" and full names are fine; anything else must be exactly a month.
  if (i < 0) return null;
  const full = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ][i]!;
  const w = word.toLowerCase().replace(/\.$/, '');
  return full.startsWith(w) && w.length >= 3 ? i + 1 : null;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length <= 2 ? 2000 + n : n;
}

function validDate(year: number, month: number, day: number): Date | null {
  if (year < 1950 || year > 2100 || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/**
 * A date of joining. Day-first, as dates are written in Pakistan:
 * "2024-03-01" (also what the browser sends for an Excel date cell),
 * "01/03/2024", "1-3-24", "1.3.2024", "1 Mar 2024", "1-Mar-24", "Mar 1, 2024".
 */
export function parseDateCell(value: string): Date | null {
  const v = value.trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return validDate(fullYear(m[3]!), Number(m[2]), Number(m[1]));
  m = v.match(/^(\d{1,2})[\s-]+([A-Za-z]+)\.?,?[\s-]+(\d{2}|\d{4})$/);
  if (m) {
    const month = monthIndex(m[2]!);
    return month ? validDate(fullYear(m[3]!), month, Number(m[1])) : null;
  }
  m = v.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = monthIndex(m[1]!);
    return month ? validDate(Number(m[3]), month, Number(m[2])) : null;
  }
  return null;
}

/**
 * The pay month of a row: "September 2026", "Sep 2026", "Sep-26",
 * "2026-09", "09/2026", or a full date ("2026-09-01", "01/09/2026"), whose
 * day is ignored.
 */
export function parseMonthCell(value: string): { year: number; month: number } | null {
  const v = value.trim();
  let m = v.match(/^([A-Za-z]+)\.?[\s,/-]+(\d{2}|\d{4})$/);
  if (m) {
    const month = monthIndex(m[1]!);
    return month ? { year: fullYear(m[2]!), month } : null;
  }
  m = v.match(/^(\d{4})[/-](\d{1,2})$/);
  if (m) return yearMonth(Number(m[1]), Number(m[2]));
  m = v.match(/^(\d{1,2})[/-](\d{4})$/);
  if (m) return yearMonth(Number(m[2]), Number(m[1]));
  const date = parseDateCell(v);
  return date ? { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 } : null;
}

function yearMonth(year: number, month: number): { year: number; month: number } | null {
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? { year, month } : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A cell's text, or undefined when blank. */
function text(value: string | undefined, max = 120): string | undefined {
  const t = value?.trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  return t.slice(0, max);
}

/** Amount cells may carry a currency label: "PKR 150,000", "Rs. 5,000". */
function amountCell(value: string | undefined): string {
  return (value ?? '').trim().replace(/^(pkr|rs\.?)\s*/i, '');
}

/** Read one row's cells. Problems come back as messages, never thrown. */
export function readRow(raw: PayrollImportRow): {
  values: Omit<ImportValues, 'net'>;
  month: { year: number; month: number } | null;
  errors: string[];
} {
  const errors: string[] = [];

  /** Undefined when blank, so the saved amount is kept. */
  const amount = (cell: string | undefined, label: string): Decimal | undefined => {
    const text = amountCell(cell);
    if (text === '') return undefined;
    const result = readAmount(text);
    if (typeof result === 'string') {
      errors.push(`${label} ${result}.`);
      return undefined;
    }
    return result;
  };
  if (!raw.basic?.trim()) errors.push('Basic salary is empty.');
  const salary = amount(raw.basic, 'Basic salary') ?? new D(0);
  const bonus = amount(raw.bonus, 'Bonus');
  const commission = amount(raw.commission, 'Commission');
  const deduction = amount(raw.deduction, 'Deduction');
  const tax = amount(raw.tax, 'Tax');

  let cnic: string | undefined;
  const cnicRaw = text(raw.cnic, 40);
  if (cnicRaw) {
    const parsed = parseCnic(cnicRaw);
    if (parsed) cnic = parsed;
    else errors.push('CNIC must have 13 digits, like 35202-1234567-1.');
  }

  let dateOfJoining: Date | undefined;
  const dojRaw = text(raw.doj, 40);
  if (dojRaw) {
    const parsed = parseDateCell(dojRaw);
    if (parsed) dateOfJoining = parsed;
    else errors.push(`Date of joining "${dojRaw}" is not a date (use DD/MM/YYYY).`);
  }

  let paymentMethod: PayrollPaymentMethod | undefined;
  const methodRaw = text(raw.paymentMethod, 40);
  if (methodRaw) {
    const parsed = parsePaymentMethod(methodRaw);
    if (parsed) paymentMethod = parsed;
    else errors.push(`Payment method "${methodRaw}" is not bank transfer, cash or cheque.`);
  }

  let email: string | undefined;
  const emailRaw = text(raw.email, 254);
  if (emailRaw) {
    if (EMAIL.test(emailRaw)) email = emailRaw.toLowerCase();
    else errors.push(`Email "${emailRaw}" is not an email address.`);
  }

  let month: { year: number; month: number } | null = null;
  const monthRaw = text(raw.month, 40);
  if (monthRaw) {
    month = parseMonthCell(monthRaw);
    if (!month) errors.push(`Month "${monthRaw}" is not a month (use e.g. September 2026).`);
  }

  return {
    values: {
      name: text(raw.name),
      designation: text(raw.designation),
      dateOfJoining,
      cnic,
      paymentMethod,
      email,
      bankName: text(raw.bankName),
      accountTitle: text(raw.accountTitle),
      accountNumber: text(raw.accountNumber, 64),
      salary,
      bonus,
      commission,
      deduction,
      tax,
    },
    month,
    errors,
  };
}

/**
 * Read, resolve the month and match every row.
 *
 * Matching, first hit wins:
 * 1. someone on payroll with the row's email, then CNIC, then (only when
 *    exactly one person has it) name;
 * 2. a platform staff member with the row's email, then (only when unique)
 *    name, who is added to payroll;
 * 3. otherwise a new person with no platform account, which needs a name.
 *
 * `target` is the month picked in the dialog; without one, every row's
 * month cell must name the same month.
 */
export function planImport(input: {
  rows: PayrollImportRow[];
  target: { year: number; month: number } | null;
  roster: RosterPerson[];
  staff: StaffMember[];
  /** Roster ids that already have a line in the month's run, with its amounts. */
  inRun: Map<string, LineExtras>;
  runStatus: 'DRAFT' | 'PAID' | null;
}): ImportPlan {
  const read = input.rows.map((raw) => ({ raw, ...readRow(raw) }));
  const sheetErrors: string[] = [];

  let target = input.target;
  if (!target) {
    // The month most rows name, when that is more than half of them; the
    // odd rows then show a month error rather than blocking the whole sheet.
    const seen = new Map<string, { month: { year: number; month: number }; count: number }>();
    let withMonth = 0;
    for (const r of read) {
      if (!r.month) continue;
      withMonth += 1;
      const key = `${r.month.year}-${r.month.month}`;
      seen.set(key, { month: r.month, count: (seen.get(key)?.count ?? 0) + 1 });
    }
    const top = [...seen.values()].sort((a, b) => b.count - a.count)[0];
    if (top && top.count * 2 > withMonth) target = top.month;
    else if (!top) sheetErrors.push('Pick the month this sheet is for.');
    else sheetErrors.push('The sheet has rows for more than one month. Pick the month to import.');
  }
  if (input.runStatus === 'PAID' && target) {
    sheetErrors.push(
      `${periodLabel(target.year, target.month)} is already paid. Undo the payment to import into it.`,
    );
  }

  const rosterByEmail = new Map<string, RosterPerson>();
  const rosterByCnic = new Map<string, RosterPerson>();
  const rosterByName = new Map<string, RosterPerson[]>();
  const rosterByUser = new Map<string, RosterPerson>();
  const rosterById = new Map(input.roster.map((p) => [p.id, p]));
  for (const p of input.roster) {
    if (p.email) rosterByEmail.set(p.email.toLowerCase(), p);
    if (p.cnic) rosterByCnic.set(p.cnic, p);
    const k = nameKey(p.name);
    rosterByName.set(k, [...(rosterByName.get(k) ?? []), p]);
    if (p.userId) rosterByUser.set(p.userId, p);
  }
  const staffByEmail = new Map(input.staff.map((s) => [s.email.toLowerCase(), s]));
  const staffByName = new Map<string, StaffMember[]>();
  for (const s of input.staff) {
    const k = nameKey(s.name);
    staffByName.set(k, [...(staffByName.get(k) ?? []), s]);
  }

  // Which sheet row claimed each person first, to catch duplicates.
  const claimed = new Map<string, number>();
  const rows: PlannedRow[] = read.map((r) => {
    const errors = [...r.errors];
    const v = r.values;
    if (target && r.month && (r.month.year !== target.year || r.month.month !== target.month)) {
      errors.push(
        `Month is ${periodLabel(r.month.year, r.month.month)}, not ${periodLabel(target.year, target.month)}.`,
      );
    }

    let target_: ImportTarget | null = null;
    let matchedBy: PlannedRow['matchedBy'] = null;
    let displayName = v.name ?? '';

    const onPayroll = (p: RosterPerson, by: 'email' | 'cnic' | 'name') => {
      target_ = { match: 'ON_PAYROLL', employeeId: p.id };
      matchedBy = by;
      displayName = displayName || p.name;
    };
    const staffEmail = v.email ? staffByEmail.get(v.email) : undefined;
    // Everyone with this name, on payroll or on the platform, counted once
    // per person (a staff member on payroll appears in both lists).
    const sameName = new Map<string, { roster?: RosterPerson; staff?: StaffMember }>();
    if (v.name) {
      const k = nameKey(v.name);
      for (const p of rosterByName.get(k) ?? []) {
        sameName.set(p.userId ? `u:${p.userId}` : `e:${p.id}`, { roster: p });
      }
      for (const st of staffByName.get(k) ?? []) {
        const key = `u:${st.id}`;
        sameName.set(key, { ...sameName.get(key), staff: st });
      }
    }

    // Exact identifiers first (email, CNIC, a staff account's email); a name
    // only when exactly one person has it.
    if (v.email && rosterByEmail.has(v.email)) onPayroll(rosterByEmail.get(v.email)!, 'email');
    else if (v.cnic && rosterByCnic.has(v.cnic)) onPayroll(rosterByCnic.get(v.cnic)!, 'cnic');
    else if (staffEmail) {
      // A staff member whose payroll email differs from their account email.
      const existing = rosterByUser.get(staffEmail.id);
      if (existing) onPayroll(existing, 'email');
      else {
        target_ = { match: 'PLATFORM_USER', userId: staffEmail.id };
        matchedBy = 'email';
        displayName = displayName || staffEmail.name;
      }
    } else if (sameName.size > 1) {
      // Guessing would pay the wrong person or create a duplicate.
      errors.push(`More than one person is named "${v.name}". Add their email or CNIC to this row.`);
    } else if (sameName.size === 1) {
      const only = [...sameName.values()][0]!;
      const person = only.roster ?? (only.staff ? rosterByUser.get(only.staff.id) : undefined);
      if (person?.cnic && v.cnic && person.cnic !== v.cnic) {
        // Same name, different CNIC: a different person, or a typo.
        errors.push(`Name matches ${person.name}, but the CNIC is different. Check the CNIC or add their email.`);
      } else if (person) onPayroll(person, 'name');
      else {
        target_ = { match: 'PLATFORM_USER', userId: only.staff!.id };
        matchedBy = 'name';
      }
    } else if (v.name) {
      target_ = { match: 'NEW_PERSON' };
    } else {
      errors.push('Name is empty, and no email or CNIC matches anyone on payroll.');
    }

    // The row's CNIC must not belong to someone other than the person matched.
    const cnicOwner = v.cnic ? rosterByCnic.get(v.cnic) : undefined;
    const matched = target_ as ImportTarget | null;
    if (cnicOwner && matched && !(matched.match === 'ON_PAYROLL' && matched.employeeId === cnicOwner.id)) {
      errors.push(`CNIC ${v.cnic} belongs to ${cnicOwner.name}, not the person this row matches.`);
      target_ = null;
    }
    // Nor a staff account's email: it would become this person's payslip
    // address and send their salary to someone else.
    const afterCnic = target_ as ImportTarget | null;
    if (staffEmail && afterCnic) {
      const sameAccount =
        afterCnic.match === 'PLATFORM_USER'
          ? afterCnic.userId === staffEmail.id
          : afterCnic.match === 'ON_PAYROLL' && rosterById.get(afterCnic.employeeId)?.userId === staffEmail.id;
      if (!sameAccount) {
        errors.push(`Email ${v.email} belongs to ${staffEmail.name}, not the person this row matches.`);
        target_ = null;
      }
    }

    const t = target_ as ImportTarget | null;
    if (t) {
      const key =
        t.match === 'ON_PAYROLL'
          ? `e:${t.employeeId}`
          : t.match === 'PLATFORM_USER'
            ? `u:${t.userId}`
            : `n:${v.cnic ?? v.email ?? nameKey(displayName)}`;
      const first = claimed.get(key);
      if (first !== undefined) errors.push(`Same person as row ${first}.`);
      else claimed.set(key, r.raw.row);
    }

    const saved = t?.match === 'ON_PAYROLL' ? input.inRun.get(t.employeeId) : undefined;
    let net: Decimal | null = null;
    if (errors.length === 0) {
      net = netOrNull(resolveAmounts({ ...v, net: new D(0) }, saved));
      if (!net) errors.push('Deduction and tax are larger than basic, bonus and commission.');
    }
    return {
      row: r.raw.row,
      name: displayName,
      match: t?.match ?? null,
      matchedBy,
      inRun: !!saved,
      errors,
      values: errors.length === 0 && net ? { ...v, net } : null,
      target: t,
    };
  });

  return { year: target?.year ?? null, month: target?.month ?? null, rows, errors: sheetErrors };
}
