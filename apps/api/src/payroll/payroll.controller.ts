import { Body, Controller, Delete, Get, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  addPayrollEmployeesSchema,
  type AddPayrollEmployeesInput,
  addPayrollItemSchema,
  type AddPayrollItemInput,
  createPayrollRunSchema,
  type CreatePayrollRunInput,
  cuid,
  payPayrollRunSchema,
  type PayPayrollRunInput,
  payrollImportSchema,
  type PayrollImportInput,
  sendPayslipsSchema,
  type SendPayslipsInput,
  updatePayrollEmployeeSchema,
  type UpdatePayrollEmployeeInput,
  updatePayrollItemSchema,
  type UpdatePayrollItemInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { sendPdf } from '../signatures/send-pdf';
import { PayrollService } from './payroll.service';

/**
 * Payroll, gated on the `Payroll` CASL subject: Admin and Finance only (the
 * Layer 5 finance revocation removes it from everyone else). Responses carry
 * salaries and bank details, so nothing here is reachable without it.
 */
@Controller('finance/payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('staff')
  @RequireAbility('read', 'Payroll')
  staff(@RequestUserScope() scope: UserScope) {
    return this.payroll.listStaff(scope);
  }

  @Get('employees')
  @RequireAbility('read', 'Payroll')
  employees(@RequestUserScope() scope: UserScope) {
    return this.payroll.listEmployees(scope);
  }

  @Post('employees')
  @RequireAbility('create', 'Payroll')
  addEmployees(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(addPayrollEmployeesSchema)) input: AddPayrollEmployeesInput,
  ) {
    return this.payroll.addEmployees(scope, input);
  }

  @Patch('employees/:id')
  @RequireAbility('update', 'Payroll')
  updateEmployee(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updatePayrollEmployeeSchema)) input: UpdatePayrollEmployeeInput,
  ) {
    return this.payroll.updateEmployee(scope, id, input);
  }

  @Delete('employees/:id')
  @RequireAbility('delete', 'Payroll')
  async removeEmployee(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.payroll.removeEmployee(scope, id);
    return { ok: true };
  }

  /** What importing this sheet would do. Writes nothing. */
  @Post('import/preview')
  @RequireAbility('read', 'Payroll')
  previewImport(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(payrollImportSchema)) input: PayrollImportInput,
  ) {
    return this.payroll.previewImport(scope, input);
  }

  @Post('import')
  @RequireAbility('create', 'Payroll')
  commitImport(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(payrollImportSchema)) input: PayrollImportInput,
  ) {
    return this.payroll.commitImport(scope, input);
  }

  @Get('runs')
  @RequireAbility('read', 'Payroll')
  runs(@RequestUserScope() scope: UserScope) {
    return this.payroll.listRuns(scope);
  }

  @Post('runs')
  @RequireAbility('create', 'Payroll')
  createRun(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(createPayrollRunSchema)) input: CreatePayrollRunInput,
  ) {
    return this.payroll.createRun(scope, input);
  }

  @Get('runs/:id')
  @RequireAbility('read', 'Payroll')
  run(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.payroll.getRun(scope, id);
  }

  @Delete('runs/:id')
  @RequireAbility('delete', 'Payroll')
  async deleteRun(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.payroll.deleteRun(scope, id);
    return { ok: true };
  }

  @Post('runs/:id/items')
  @RequireAbility('update', 'Payroll')
  addItem(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(addPayrollItemSchema)) input: AddPayrollItemInput,
  ) {
    return this.payroll.addItem(scope, id, input);
  }

  @Patch('runs/:id/items/:itemId')
  @RequireAbility('update', 'Payroll')
  updateItem(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('itemId', new ZodValidationPipe(cuid)) itemId: string,
    @Body(new ZodValidationPipe(updatePayrollItemSchema)) input: UpdatePayrollItemInput,
  ) {
    return this.payroll.updateItem(scope, id, itemId, input);
  }

  @Delete('runs/:id/items/:itemId')
  @RequireAbility('update', 'Payroll')
  removeItem(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('itemId', new ZodValidationPipe(cuid)) itemId: string,
  ) {
    return this.payroll.removeItem(scope, id, itemId);
  }

  @Post('runs/:id/pay')
  @RequireAbility('update', 'Payroll')
  pay(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(payPayrollRunSchema)) input: PayPayrollRunInput,
  ) {
    return this.payroll.pay(scope, id, input);
  }

  @Post('runs/:id/unpay')
  @RequireAbility('update', 'Payroll')
  unpay(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.payroll.unpay(scope, id);
  }

  /** The body carries a mailbox password: used for this request only, never stored. */
  @Post('runs/:id/send-payslips')
  @RequireAbility('update', 'Payroll')
  sendPayslips(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(sendPayslipsSchema)) input: SendPayslipsInput,
  ) {
    return this.payroll.sendPayslips(scope, id, input);
  }

  @Get('runs/:id/payslips.pdf')
  @RequireAbility('read', 'Payroll')
  async payslips(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.payroll.allPayslipsPdf(scope, id), 'attachment');
  }

  @Get('runs/:id/items/:itemId/payslip.pdf')
  @RequireAbility('read', 'Payroll')
  async payslip(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('itemId', new ZodValidationPipe(cuid)) itemId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.payroll.payslipPdf(scope, id, itemId), 'attachment');
  }

  @Get('runs/:id/bank-transfer.csv')
  @RequireAbility('read', 'Payroll')
  async bankTransfer(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.payroll.bankTransferCsv(scope, id);
    // BOM so Excel opens the file as UTF-8 (names with non-ASCII letters).
    const body = Buffer.from(`﻿${file.body}`, 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Length', String(body.byteLength));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    // Bank account numbers: nothing downstream should keep a copy.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  }
}
