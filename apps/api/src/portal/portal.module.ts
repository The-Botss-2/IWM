import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { SignaturesModule } from '../signatures/signatures.module';
import { PortalBillingController } from './portal-billing.controller';
import { PortalBillingService } from './portal-billing.service';
import { PortalDocumentsController } from './portal-documents.controller';
import { PortalDocumentsService } from './portal-documents.service';
import { PortalMeController } from './portal-me.controller';
import { PortalOverviewController, PortalOverviewService } from './portal-overview.controller';
import { PortalProjectsController } from './portal-projects.controller';
import { PortalProjectsService } from './portal-projects.service';
import { PortalScopeService } from './portal-scope';
import { PortalSignaturesController } from './portal-signatures.controller';
import { PortalSignaturesService } from './portal-signatures.service';
import { PortalService } from './portal.service';

/**
 * Client portal. Every controller here is `@PortalRoute()`: CLIENT accounts
 * only, authorized by `PortalScopeService`, never by CASL. Prisma, email and
 * the audit log are global modules.
 */
@Module({
  imports: [FilesModule, InvoicesModule, SignaturesModule],
  controllers: [
    PortalMeController,
    PortalOverviewController,
    PortalProjectsController,
    PortalDocumentsController,
    PortalSignaturesController,
    PortalBillingController,
  ],
  providers: [
    PortalScopeService,
    PortalService,
    PortalOverviewService,
    PortalProjectsService,
    PortalDocumentsService,
    PortalSignaturesService,
    PortalBillingService,
  ],
  exports: [PortalScopeService],
})
export class PortalModule {}
