import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { cuid, type MailFolderResyncQueued } from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { MailReadService } from './mail-read.service';

@Controller('mail')
export class MailFoldersController {
  constructor(private readonly read: MailReadService) {}

  @Get('folders')
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query('accountId', new ZodValidationPipe(cuid)) accountId: string,
  ) {
    return this.read.listFolders(user.id, accountId);
  }

  @Post('accounts/:accountId/sync')
  @SkipPermissions()
  sync(
    @CurrentUser() user: AuthedUser,
    @Param('accountId', new ZodValidationPipe(cuid)) accountId: string,
  ) {
    return this.read.triggerSync(user.id, accountId);
  }

  @Post('folders/:folderId/mark-all-read')
  @SkipPermissions()
  markAllRead(
    @CurrentUser() user: AuthedUser,
    @Param('folderId', new ZodValidationPipe(cuid)) folderId: string,
  ) {
    return this.read.markFolderAllRead(user.id, folderId);
  }

  @Post('folders/:folderId/empty')
  @SkipPermissions()
  empty(
    @CurrentUser() user: AuthedUser,
    @Param('folderId', new ZodValidationPipe(cuid)) folderId: string,
  ) {
    return this.read.emptyFolder(user.id, folderId);
  }

  /**
   * Force a full re-sync of a single folder. Rewinds `uidNext` to 0 then
   * re-fetches every UID from IMAP. The sync's UPDATE branch heals
   * mismatched attachment metadata in place - used to repair sent mail
   * that landed before the appendToSent attachment-parsing fix shipped.
   * Expensive; intended as a one-shot recovery action triggered from the
   * folder context menu, not a routine call.
   */
  // Runs as a background job: 202 as soon as it is queued.
  @Post('folders/:folderId/resync')
  @HttpCode(HttpStatus.ACCEPTED)
  @SkipPermissions()
  resync(
    @CurrentUser() user: AuthedUser,
    @Param('folderId', new ZodValidationPipe(cuid)) folderId: string,
  ): Promise<MailFolderResyncQueued> {
    return this.read.resyncFolder(user.id, folderId);
  }
}
