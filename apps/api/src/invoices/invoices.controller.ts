import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createInvoiceSchema,
  type CreateInvoiceInput,
  cuid,
  invoicePreviewSchema,
  type InvoicePreviewInput,
  invoiceSettingsSchema,
  type InvoiceSettings,
  listInvoicesQuerySchema,
  type ListInvoicesQuery,
  recordPaymentSchema,
  type RecordPaymentInput,
  sendInvoiceSchema,
  type SendInvoiceInput,
  setInvoiceStatusSchema,
  type SetInvoiceStatusInput,
  updateInvoiceSchema,
  type UpdateInvoiceInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { InvoicesService } from './invoices.service';

const yearQuerySchema = z.object({ year: z.coerce.number().int().min(2000).optional() });

/**
 * Invoices are gated on the `Invoice` / `Payment` CASL subjects, NOT on
 * `Workspace`. The old `read|manage Workspace` guards let any workspace MEMBER
 * read every invoice, because Layer 1 of the ability factory grants them
 * `read all`. The finance subjects are revoked at Layer 5 for anyone without
 * `hasFinanceAccess`, so these guards now mean what they say.
 */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  // Static routes first: `:id` would otherwise swallow them.

  @Get('templates')
  @RequireAbility('read', 'Invoice')
  templates(@RequestUserScope() scope: UserScope) {
    return this.invoices.listTemplates(scope);
  }

  @Get('settings')
  @RequireAbility('read', 'Invoice')
  settings(@RequestUserScope() scope: UserScope) {
    return this.invoices.getSettings(scope);
  }

  @Put('settings')
  @RequireAbility('update', 'Invoice')
  updateSettings(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(invoiceSettingsSchema)) input: InvoiceSettings,
  ) {
    return this.invoices.updateSettings(scope, input);
  }

  /**
   * Rendered HTML for the editor's live preview iframe. The document is fully
   * self-contained, so the response locks everything else down: no script,
   * no network, no framing by anyone but a sandboxed srcdoc.
   */
  @Post('preview')
  @RequireAbility('read', 'Invoice')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
  )
  preview(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(invoicePreviewSchema)) input: InvoicePreviewInput,
  ) {
    return this.invoices.preview(scope, input);
  }

  @Get('next-number')
  @RequireAbility('read', 'Invoice')
  async nextNumber(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(yearQuerySchema)) q: { year?: number },
  ) {
    return { number: await this.invoices.peekNextNumber(scope, q.year) };
  }

  @Get()
  @RequireAbility('read', 'Invoice')
  list(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listInvoicesQuerySchema)) q: ListInvoicesQuery,
  ) {
    return this.invoices.list(scope, q);
  }

  @Post()
  @RequireAbility('create', 'Invoice')
  create(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(createInvoiceSchema)) input: CreateInvoiceInput,
  ) {
    return this.invoices.create(scope, input);
  }

  @Get(':id')
  @RequireAbility('read', 'Invoice')
  get(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.invoices.get(scope, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Invoice')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateInvoiceSchema)) input: UpdateInvoiceInput,
  ) {
    return this.invoices.update(scope, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Invoice')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.invoices.remove(scope, id);
    return { ok: true };
  }

  @Post(':id/send')
  @RequireAbility('update', 'Invoice')
  send(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(sendInvoiceSchema)) input: SendInvoiceInput,
  ) {
    return this.invoices.send(scope, id, input);
  }

  @Post(':id/status')
  @RequireAbility('update', 'Invoice')
  setStatus(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(setInvoiceStatusSchema)) input: SetInvoiceStatusInput,
  ) {
    return this.invoices.setStatus(scope, id, input);
  }

  @Post(':id/payments')
  @RequireAbility('create', 'Payment')
  recordPayment(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(recordPaymentSchema)) input: RecordPaymentInput,
  ) {
    return this.invoices.recordPayment(scope, id, input);
  }

  @Post(':id/pdf')
  @RequireAbility('read', 'Invoice')
  pdf(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.invoices.generatePdfUrl(scope, id);
  }
}
