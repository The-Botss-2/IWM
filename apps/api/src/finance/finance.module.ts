import { Module } from '@nestjs/common';

import { ClientBillingController } from './client-billing.controller';
import { ClientBillingService } from './client-billing.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { FinancePickersController } from './finance-pickers.controller';
import { FinanceSummaryController } from './finance-summary.controller';
import { FinanceSummaryService } from './finance-summary.service';
import { MilestoneDeliveryService } from './milestone-delivery.service';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { PaymentSourcesController } from './payment-sources.controller';
import { PaymentSourcesService } from './payment-sources.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * No `imports:` needed - PrismaModule and NotificationsModule are both
 * `@Global()`.
 *
 * `PaymentsService` is exported so InvoicesModule can delegate its
 * record-payment route here: an invoice payment must advance the invoice AND
 * the contract it was raised against, and there is only one place that knows
 * how to do both.
 *
 * `MilestoneDeliveryService` is exported so the sprints and tasks modules can
 * fire delivery sync without depending on the rest of the finance surface.
 */
@Module({
  controllers: [
    ContractsController,
    // MilestonesController owns /finance/awaiting-payment and the
    // /finance/milestones/* routes, so it must be registered before any
    // controller with a competing ':id' wildcard on the same prefix.
    MilestonesController,
    PaymentsController,
    ExpensesController,
    PaymentSourcesController,
    FinanceSummaryController,
    FinancePickersController,
    ClientBillingController,
  ],
  providers: [
    ContractsService,
    MilestonesService,
    MilestoneDeliveryService,
    PaymentsService,
    ExpensesService,
    PaymentSourcesService,
    FinanceSummaryService,
    ClientBillingService,
  ],
  exports: [PaymentsService, MilestoneDeliveryService],
})
export class FinanceModule {}
