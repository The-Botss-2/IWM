import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY, moneyInput, rateString } from './common/money.js';
import { mailHost } from './mail.js';

/**
 * Payroll. A roster of people on payroll (each with a default monthly salary
 * and bank details) and one run per month. Marking a run paid records one
 * SALARY expense per person, so salaries flow into the financial reports.
 *
 * Amounts are PKR. `net` is always computed by the server
 * (salary + bonus + commission - deduction - tax); clients never send it.
 *
 * People are picked from the platform's staff, or imported from a CSV/XLSX
 * sheet, which may also add people who have no platform account (`userId`
 * null).
 */

export const PayrollRunStatus = z.enum(['DRAFT', 'PAID']);
export type PayrollRunStatus = z.infer<typeof PayrollRunStatus>;

/** Only BANK_TRANSFER lines go into the bank transfer CSV. */
export const PayrollPaymentMethod = z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE']);
export type PayrollPaymentMethod = z.infer<typeof PayrollPaymentMethod>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** A calendar date with no time zone, e.g. a date of joining: "2024-03-01". */
export const payrollDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** CNIC as stored and returned: 12345-1234567-1. */
export const cnicString = z.string().regex(/^\d{5}-\d{7}-\d$/);

/** Form input: blank clears the field. */
const optionalEmail = z
  .union([z.literal(''), z.string().trim().email().max(254)])
  .nullable()
  .optional();
const optionalCnic = z
  .union([z.literal(''), z.string().trim().regex(/^\d{5}-?\d{7}-?\d$/, 'CNIC must have 13 digits.')])
  .nullable()
  .optional();
const optionalDate = z.union([z.literal(''), payrollDate]).nullable().optional();

/** A staff member as offered in the "Add people" picker. */
export const payrollStaffSchema = z.object({
  id: cuid,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  /** The roster row when this person is already on payroll. */
  payrollEmployeeId: cuid.nullable(),
});
export type PayrollStaff = z.infer<typeof payrollStaffSchema>;

export const payrollStaffListSchema = z.object({ items: z.array(payrollStaffSchema) });
export type PayrollStaffList = z.infer<typeof payrollStaffListSchema>;

export const payrollEmployeeSchema = z.object({
  id: cuid,
  /** Null for someone on payroll without a platform account. */
  userId: cuid.nullable(),
  name: z.string(),
  /** Where payslips go: the payslip email if set, else the account email. */
  email: z.string().nullable(),
  image: z.string().nullable(),
  cnic: cnicString.nullable(),
  dateOfJoining: payrollDate.nullable(),
  paymentMethod: PayrollPaymentMethod,
  monthlySalary: decimalString,
  currency: ISO_CURRENCY,
  designation: z.string().nullable(),
  bankName: z.string().nullable(),
  accountTitle: z.string().nullable(),
  accountNumber: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PayrollEmployee = z.infer<typeof payrollEmployeeSchema>;

export const payrollEmployeeListSchema = z.object({ items: z.array(payrollEmployeeSchema) });
export type PayrollEmployeeList = z.infer<typeof payrollEmployeeListSchema>;

const employeeFields = {
  monthlySalary: moneyInput,
  designation: optionalText(120),
  bankName: optionalText(120),
  accountTitle: optionalText(120),
  accountNumber: optionalText(64),
};

export const addPayrollEmployeesSchema = z.object({
  people: z
    .array(z.object({ userId: cuid, ...employeeFields }))
    .min(1)
    .max(500),
});
export type AddPayrollEmployeesInput = z.infer<typeof addPayrollEmployeesSchema>;

export const updatePayrollEmployeeSchema = z.object({
  /** Only for people without a platform account; ignored for everyone else. */
  name: z.string().trim().min(1).max(120).optional(),
  email: optionalEmail,
  cnic: optionalCnic,
  dateOfJoining: optionalDate,
  paymentMethod: PayrollPaymentMethod.optional(),
  monthlySalary: moneyInput.optional(),
  designation: optionalText(120),
  bankName: optionalText(120),
  accountTitle: optionalText(120),
  accountNumber: optionalText(64),
  isActive: z.boolean().optional(),
});
export type UpdatePayrollEmployeeInput = z.infer<typeof updatePayrollEmployeeSchema>;

export const payrollItemSchema = z.object({
  id: cuid,
  /** Null once the person has been removed from the platform. */
  employeeId: cuid.nullable(),
  userId: cuid.nullable(),
  employeeName: z.string(),
  designation: z.string().nullable(),
  bankName: z.string().nullable(),
  accountTitle: z.string().nullable(),
  accountNumber: z.string().nullable(),
  cnic: z.string().nullable(),
  dateOfJoining: payrollDate.nullable(),
  paymentMethod: PayrollPaymentMethod,
  email: z.string().nullable(),
  salary: decimalString,
  bonus: decimalString,
  commission: decimalString,
  deduction: decimalString,
  tax: decimalString,
  net: decimalString,
  bonusNote: z.string().nullable(),
  deductionNote: z.string().nullable(),
  expenseId: cuid.nullable(),
  payslipSentAt: z.coerce.date().nullable(),
  payslipSentTo: z.string().nullable(),
});
export type PayrollItem = z.infer<typeof payrollItemSchema>;

export const payrollRunSummarySchema = z.object({
  id: cuid,
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  status: PayrollRunStatus,
  paidAt: z.coerce.date().nullable(),
  paymentSource: z.object({ id: cuid, name: z.string() }).nullable(),
  fxRate: rateString,
  currency: ISO_CURRENCY,
  people: z.number().int(),
  totalSalary: decimalString,
  totalBonus: decimalString,
  totalCommission: decimalString,
  totalDeduction: decimalString,
  totalTax: decimalString,
  totalNet: decimalString,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PayrollRunSummary = z.infer<typeof payrollRunSummarySchema>;

export const payrollRunListSchema = z.object({ items: z.array(payrollRunSummarySchema) });
export type PayrollRunList = z.infer<typeof payrollRunListSchema>;

export const payrollRunSchema = payrollRunSummarySchema.extend({
  items: z.array(payrollItemSchema),
});
export type PayrollRun = z.infer<typeof payrollRunSchema>;

export const createPayrollRunSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunSchema>;

export const addPayrollItemSchema = z.object({ employeeId: cuid });
export type AddPayrollItemInput = z.infer<typeof addPayrollItemSchema>;

export const updatePayrollItemSchema = z.object({
  salary: moneyInput.optional(),
  bonus: moneyInput.optional(),
  commission: moneyInput.optional(),
  deduction: moneyInput.optional(),
  tax: moneyInput.optional(),
  bonusNote: optionalText(300),
  deductionNote: optionalText(300),
});
export type UpdatePayrollItemInput = z.infer<typeof updatePayrollItemSchema>;

export const payPayrollRunSchema = z.object({
  paidAt: z.coerce.date(),
  paymentSourceId: cuid.nullable().optional(),
  /** PKR to the organization's base currency. Ignored when the base is PKR. */
  fxRate: z.union([rateString, z.number().positive()]).optional(),
});
export type PayPayrollRunInput = z.infer<typeof payPayrollRunSchema>;

// ---------------------------------------------------------------------------
// Import from a CSV/XLSX sheet
// ---------------------------------------------------------------------------

/**
 * One sheet row as the browser read it: every cell as text, keyed by the
 * normalized column name. The server parses and validates the values, so a
 * bad cell comes back as a row error instead of failing the whole request.
 */
const importCell = z.string().max(300).optional();
export const payrollImportRowSchema = z.object({
  /** The row number in the sheet (header is row 1), for error messages. */
  row: z.number().int().min(1),
  name: importCell,
  designation: importCell,
  doj: importCell,
  month: importCell,
  cnic: importCell,
  basic: importCell,
  bonus: importCell,
  deduction: importCell,
  commission: importCell,
  tax: importCell,
  paymentMethod: importCell,
  email: importCell,
  bankName: importCell,
  accountTitle: importCell,
  accountNumber: importCell,
});
export type PayrollImportRow = z.infer<typeof payrollImportRowSchema>;

export const payrollImportSchema = z.object({
  /** Omit both to take the month from the sheet's month column. */
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  rows: z.array(payrollImportRowSchema).min(1).max(500),
});
export type PayrollImportInput = z.infer<typeof payrollImportSchema>;

/** How a sheet row was matched to a person. */
export const PayrollImportMatch = z.enum(['ON_PAYROLL', 'PLATFORM_USER', 'NEW_PERSON']);
export type PayrollImportMatch = z.infer<typeof PayrollImportMatch>;

export const payrollImportPreviewRowSchema = z.object({
  row: z.number().int(),
  name: z.string(),
  match: PayrollImportMatch.nullable(),
  matchedBy: z.enum(['email', 'cnic', 'name']).nullable(),
  /** True when this person already has a line in the month's run. */
  inRun: z.boolean(),
  net: decimalString.nullable(),
  errors: z.array(z.string()),
});
export type PayrollImportPreviewRow = z.infer<typeof payrollImportPreviewRowSchema>;

export const payrollImportPreviewSchema = z.object({
  /** Null when no month was given and the sheet has none (or several). */
  year: z.number().int().nullable(),
  month: z.number().int().nullable(),
  /** The month's run when it already exists. */
  run: z.object({ id: cuid, status: PayrollRunStatus }).nullable(),
  rows: z.array(payrollImportPreviewRowSchema),
  /** Problems with the whole sheet, e.g. no month or a paid run. */
  errors: z.array(z.string()),
  /** People already in the run who are not in the sheet (left unchanged). */
  notInSheet: z.number().int(),
});
export type PayrollImportPreview = z.infer<typeof payrollImportPreviewSchema>;

export const payrollImportResultSchema = z.object({
  run: payrollRunSchema,
  added: z.number().int(),
  updated: z.number().int(),
  newPeople: z.number().int(),
});
export type PayrollImportResult = z.infer<typeof payrollImportResultSchema>;

// ---------------------------------------------------------------------------
// Email payslips
// ---------------------------------------------------------------------------

/**
 * The mailbox the payslips are sent from. The password is used for this one
 * request and never stored. Without `smtpHost` the server takes the host
 * from the mail settings it already has for that address's domain.
 */
export const sendPayslipsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(512),
  smtpHost: mailHost.optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  /** Implicit TLS (465). False means STARTTLS (587). */
  smtpSecure: z.boolean().optional(),
  /** Only these lines. Omit to send every payslip in the run. */
  itemIds: z.array(cuid).min(1).max(500).optional(),
});
export type SendPayslipsInput = z.infer<typeof sendPayslipsSchema>;

export const sendPayslipsResultSchema = z.object({
  results: z.array(
    z.object({
      itemId: cuid,
      name: z.string(),
      to: z.string().nullable(),
      status: z.enum(['SENT', 'FAILED', 'SKIPPED']),
      error: z.string().nullable(),
    }),
  ),
  sent: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type SendPayslipsResult = z.infer<typeof sendPayslipsResultSchema>;
