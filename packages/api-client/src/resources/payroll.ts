import { z } from 'zod';
import {
  type AddPayrollEmployeesInput,
  type AddPayrollItemInput,
  type CreatePayrollRunInput,
  type PayPayrollRunInput,
  payrollEmployeeListSchema,
  payrollEmployeeSchema,
  type PayrollImportInput,
  payrollImportPreviewSchema,
  payrollImportResultSchema,
  payrollRunListSchema,
  payrollRunSchema,
  payrollStaffListSchema,
  type SendPayslipsInput,
  sendPayslipsResultSchema,
  type UpdatePayrollEmployeeInput,
  type UpdatePayrollItemInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });

/** Payroll under /finance/payroll. Admin and Finance only. */
export class PayrollResource {
  constructor(private readonly http: HttpClient) {}

  /** Every staff member of the organization, flagged when already on payroll. */
  staff() {
    return this.http.get('/finance/payroll/staff', payrollStaffListSchema);
  }

  employees() {
    return this.http.get('/finance/payroll/employees', payrollEmployeeListSchema);
  }
  addEmployees(input: AddPayrollEmployeesInput) {
    return this.http.post('/finance/payroll/employees', payrollEmployeeListSchema, input);
  }
  updateEmployee(id: string, input: UpdatePayrollEmployeeInput) {
    return this.http.patch(`/finance/payroll/employees/${id}`, payrollEmployeeSchema, input);
  }
  removeEmployee(id: string) {
    return this.http.delete(`/finance/payroll/employees/${id}`, okSchema);
  }

  runs() {
    return this.http.get('/finance/payroll/runs', payrollRunListSchema);
  }
  run(id: string) {
    return this.http.get(`/finance/payroll/runs/${id}`, payrollRunSchema);
  }
  createRun(input: CreatePayrollRunInput) {
    return this.http.post('/finance/payroll/runs', payrollRunSchema, input);
  }
  deleteRun(id: string) {
    return this.http.delete(`/finance/payroll/runs/${id}`, okSchema);
  }
  addItem(runId: string, input: AddPayrollItemInput) {
    return this.http.post(`/finance/payroll/runs/${runId}/items`, payrollRunSchema, input);
  }
  updateItem(runId: string, itemId: string, input: UpdatePayrollItemInput) {
    return this.http.patch(`/finance/payroll/runs/${runId}/items/${itemId}`, payrollRunSchema, input);
  }
  removeItem(runId: string, itemId: string) {
    return this.http.delete(`/finance/payroll/runs/${runId}/items/${itemId}`, payrollRunSchema);
  }
  pay(runId: string, input: PayPayrollRunInput) {
    return this.http.post(`/finance/payroll/runs/${runId}/pay`, payrollRunSchema, input);
  }
  unpay(runId: string) {
    return this.http.post(`/finance/payroll/runs/${runId}/unpay`, payrollRunSchema, {});
  }

  /** What importing these sheet rows would do. Writes nothing. */
  previewImport(input: PayrollImportInput) {
    return this.http.post('/finance/payroll/import/preview', payrollImportPreviewSchema, input);
  }
  /** Apply the sheet rows to the month's run (created if missing). */
  importSheet(input: PayrollImportInput) {
    return this.http.post('/finance/payroll/import', payrollImportResultSchema, input);
  }

  /** Email payslips from a mailbox; the password is used for this call only. */
  sendPayslips(runId: string, input: SendPayslipsInput) {
    return this.http.post(`/finance/payroll/runs/${runId}/send-payslips`, sendPayslipsResultSchema, input);
  }

  /** Every payslip in the run, one page each. */
  payslipsPdf(runId: string) {
    return this.http.getBlob(`/finance/payroll/runs/${runId}/payslips.pdf`);
  }
  payslipPdf(runId: string, itemId: string) {
    return this.http.getBlob(`/finance/payroll/runs/${runId}/items/${itemId}/payslip.pdf`);
  }
  bankTransferCsv(runId: string) {
    return this.http.getBlob(`/finance/payroll/runs/${runId}/bank-transfer.csv`);
  }
}
