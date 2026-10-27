import { Controller, Get, Param } from '@nestjs/common';
import { cuid, type PortalDocument, type PortalDocumentList } from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PortalDocumentsService } from './portal-documents.service';

@PortalRoute()
@Controller('portal/clients/:clientId/documents')
export class PortalDocumentsController {
  constructor(private readonly documents: PortalDocumentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalDocumentList> {
    return this.documents.list(user.id, clientId);
  }

  @Get(':documentId')
  get(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('documentId', new ZodValidationPipe(cuid)) documentId: string,
  ): Promise<PortalDocument> {
    return this.documents.get(user.id, clientId, documentId);
  }
}
