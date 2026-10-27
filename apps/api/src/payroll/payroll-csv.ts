/**
 * The bank-transfer list for one payroll run. A generic layout that opens in
 * Excel and pastes into any bank's bulk-transfer sheet; a bank-specific
 * format can be added next to it once we have a sample file.
 */

export interface BankTransferRow {
  employeeName: string;
  accountTitle: string | null;
  bankName: string | null;
  accountNumber: string | null;
  net: string;
}

const HEADER = ['Name', 'Account title', 'Bank', 'Account number / IBAN', 'Amount (PKR)', 'Reference'];

/**
 * Rows with a zero net are left out: there is nothing to transfer. Lines end
 * in CRLF, which is what Excel and most bank portals expect.
 */
export function buildBankTransferCsv(rows: BankTransferRow[], reference: string): string {
  const lines = [HEADER.map(csvCell).join(',')];
  for (const row of rows) {
    if (Number(row.net) <= 0) continue;
    lines.push(
      [
        csvCell(row.employeeName),
        csvCell(row.accountTitle ?? ''),
        csvCell(row.bankName ?? ''),
        accountCell(row.accountNumber ?? ''),
        csvCell(row.net),
        csvCell(reference),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * An account number made only of digits is written as the Excel text
 * formula ="0123..." (CSV-escaped). Left bare, Excel opens a 14-digit local
 * account number as 1.23457E+13 and drops leading zeros, and a 16-digit one
 * loses its last digit: pasted into the bank's sheet, money goes to the
 * wrong account. Digits cannot inject anything, so the formula is safe.
 * IBANs (letters and digits) are left as they are.
 */
export function accountCell(value: string): string {
  const compact = value.replace(/\s+/g, '');
  if (/^\d+$/.test(compact)) return `"=""${compact}"""`;
  return csvCell(value);
}

/**
 * RFC 4180 escaping plus spreadsheet formula-injection neutralizing: a value
 * starting with = + - @ (or tab/CR) would run as a formula when the file is
 * opened, so it is prefixed with a single quote. Same rule as the attendance
 * export (hr/attendance-export.service.ts). Amounts are never negative here,
 * so a leading "-" only ever comes from user-typed text.
 */
export function csvCell(value: string): string {
  if (value === '' || value == null) return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
