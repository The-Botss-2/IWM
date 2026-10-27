import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { FinanceModule } from '../finance/finance.module';
import { PdfModule } from '../pdf/pdf.module';

import { InvoiceRenderService } from './invoice-render.service';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [FinanceModule, FilesModule, PdfModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceTemplatesService, InvoiceRenderService],
  // The client portal serves invoice PDFs through `ensurePdfForPortal`.
  // Payroll renders payslips with the same company branding.
  exports: [InvoicesService, InvoiceRenderService],
})
export class InvoicesModule {}
