import { Controller, Get, Param } from '@nestjs/common';

import { Public } from '../common/decorators/public.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { DocumentsService } from './documents.service';

/**
 * Anonymous read-only access to documents that have been explicitly shared via
 * `publicSlug`. Mounted at `/public/*` under the global `/api/v1` prefix so the
 * surface is obviously separate from the authenticated `/documents/*` routes.
 *
 * `@Public()` skips AuthGuard (no session required) and `@SkipPermissions()`
 * keeps the CASL guard from running over a `null` user.
 */
@Controller('public/documents')
export class PublicDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Public()
  @SkipPermissions()
  @Get(':slug')
  // The slug is opaque base64url; we don't run it through the cuid pipe.
  get(@Param('slug') slug: string) {
    return this.documents.getByPublicSlug(slug);
  }
}
