import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  cuid,
  type PortalContractList,
  type PortalInvoiceDetail,
  type PortalInvoiceList,
  type PortalPaymentList,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { sendPdf } from '../signatures/send-pdf';
import { PortalBillingService } from './portal-billing.service';

/** Main contact only; the service returns 403 for everyone else. */
@PortalRoute()
@Controller('portal/clients/:clientId')
export class PortalBillingController {
  constructor(private readonly billing: PortalBillingService) {}

  @Get('invoices')
  invoices(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalInvoiceList> {
    return this.billing.listInvoices(user.id, clientId);
  }

  @Get('invoices/:invoiceId')
  invoice(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('invoiceId', new ZodValidationPipe(cuid)) invoiceId: string,
  ): Promise<PortalInvoiceDetail> {
    return this.billing.getInvoice(user.id, clientId, invoiceId);
  }

  @Get('invoices/:invoiceId/pdf')
  async invoicePdf(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('invoiceId', new ZodValidationPipe(cuid)) invoiceId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.billing.invoicePdf(user.id, clientId, invoiceId), 'attachment');
  }

  @Get('contracts')
  contracts(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalContractList> {
    return this.billing.listContracts(user.id, clientId);
  }

  @Get('payments')
  payments(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalPaymentList> {
    return this.billing.listPayments(user.id, clientId);
  }
}
