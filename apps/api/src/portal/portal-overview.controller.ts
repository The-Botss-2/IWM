import { Controller, Get, Injectable, Param } from '@nestjs/common';
import { cuid, portalOverviewSchema, type PortalOverview } from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SignaturesService } from '../signatures/signatures.service';
import { PortalBillingService } from './portal-billing.service';
import { PortalDocumentsService } from './portal-documents.service';
import { PortalProjectsService } from './portal-projects.service';
import { PortalScopeService } from './portal-scope';

/** The portal landing page: projects, what needs signing, what is owed. */
@Injectable()
export class PortalOverviewService {
  constructor(
    private readonly scope: PortalScopeService,
    private readonly projects: PortalProjectsService,
    private readonly documents: PortalDocumentsService,
    private readonly billing: PortalBillingService,
    private readonly signatures: SignaturesService,
  ) {}

  async overview(user: AuthedUser, clientId: string): Promise<PortalOverview> {
    const contact = await this.scope.require(user.id, clientId);
    const [projects, pendingSignatures, sharedDocuments, outstanding] = await Promise.all([
      this.projects.summaries(contact),
      this.signatures.portalPendingCount(user.email, contact.workspaceId),
      this.documents.count(contact, user.id),
      // Money is billing: main contact only.
      contact.role === 'PRIMARY' ? this.billing.outstanding(contact) : Promise.resolve(null),
    ]);
    return portalOverviewSchema.parse({
      projects,
      pendingSignatures,
      sharedDocuments,
      outstanding,
    });
  }
}

@PortalRoute()
@Controller('portal/clients/:clientId/overview')
export class PortalOverviewController {
  constructor(private readonly overviewService: PortalOverviewService) {}

  @Get()
  overview(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalOverview> {
    return this.overviewService.overview(user, clientId);
  }
}
