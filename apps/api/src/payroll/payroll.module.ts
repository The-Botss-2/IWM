import { Module } from '@nestjs/common';

import { InvoicesModule } from '../invoices/invoices.module';
import { PdfModule } from '../pdf/pdf.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { PayslipRenderService } from './payslip-render.service';

/**
 * Payroll lives outside FinanceModule because payslips reuse the invoice
 * branding (InvoicesModule), and InvoicesModule already imports
 * FinanceModule. Its routes still sit under /finance/payroll.
 */
@Module({
  imports: [InvoicesModule, PdfModule],
  controllers: [PayrollController],
  providers: [PayrollService, PayslipRenderService],
})
export class PayrollModule {}
