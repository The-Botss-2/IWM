import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  bulkDeleteMailMessagesSchema,
  type BulkDeleteMailMessagesInput,
  bulkFlagMailMessagesSchema,
  type BulkFlagMailMessagesInput,
  bulkMoveMailMessagesSchema,
  type BulkMoveMailMessagesInput,
  cuid,
  isSafeInlineImage,
  listMailMessagesQuerySchema,
  type ListMailMessagesQuery,
  moveMailMessageSchema,
  recipientSuggestionsQuerySchema,
  type RecipientSuggestionsQuery,
  type MoveMailMessageInput,
  saveMailDraftSchema,
  type SaveMailDraftInput,
  sendMailMessageSchema,
  type SendMailMessageInput,
} from '@botss/shared-types';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ImapSyncService } from './imap-sync.service';
import { MailReadService } from './mail-read.service';
import { MailSendService } from './mail-send.service';
import { PrismaService } from '../prisma/prisma.service';

const flagPatchSchema = z.object({
  op: z.enum(['read', 'unread', 'star', 'unstar']),
});

@Controller('mail/messages')
export class MailMessagesController {
  constructor(
    private readonly send: MailSendService,
    private readonly read: MailReadService,
    private readonly sync: ImapSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listMailMessagesQuerySchema)) q: ListMailMessagesQuery,
  ) {
    return this.read.listMessages(user.id, q);
  }

  /**
   * Compose autocomplete: addresses the user has previously sent to.
   * Declared before `:id` so the literal path wins over the param route.
   */
  @Get('recipient-suggestions')
  @SkipPermissions()
  recipientSuggestions(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(recipientSuggestionsQuerySchema))
    q: RecipientSuggestionsQuery,
  ) {
    return this.read.recipientSuggestions(user.id, q);
  }

  @Get(':id')
  @SkipPermissions()
  get(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.read.getMessage(user.id, id);
  }

  @Patch(':id/flags')
  @SkipPermissions()
  setFlag(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(flagPatchSchema)) input: z.infer<typeof flagPatchSchema>,
  ) {
    return this.read.setFlag(user.id, id, input.op);
  }

  /**
   * Bulk-move a selection to Archive / Trash / Spam / Inbox (or any folder
   * by id). One IMAP MOVE per source folder under the hood; foreign ids are
   * silently dropped so the multi-select UI doesn't need to know per-message
   * ownership before firing.
   *
   * NOTE: the static `bulk/*` routes MUST be declared before the
   * parameterized `:id/move` route below. Express matches in declaration
   * order, so if `:id/move` came first, `POST /mail/messages/bulk/move`
   * would bind `id = "bulk"` and 404 with "Message not found".
   */
  @Post('bulk/move')
  @SkipPermissions()
  bulkMove(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(bulkMoveMailMessagesSchema))
    input: BulkMoveMailMessagesInput,
  ) {
    const target: { folderId?: string; role?: 'ARCHIVE' | 'TRASH' | 'SPAM' | 'INBOX' } = {};
    if (input.folderId) target.folderId = input.folderId;
    if (input.role) target.role = input.role;
    return this.read.bulkMoveMessages(user.id, input.ids, target);
  }

  /** Bulk read/unread/star/unstar. */
  @Post('bulk/flags')
  @SkipPermissions()
  bulkFlags(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(bulkFlagMailMessagesSchema))
    input: BulkFlagMailMessagesInput,
  ) {
    return this.read.bulkSetFlag(user.id, input.ids, input.op);
  }

  /** Bulk \\Deleted + EXPUNGE. Service layer enforces "Trash/Spam only" so
   *  this can't be turned into a foot-gun by a hand-rolled client. */
  @Post('bulk/delete')
  @SkipPermissions()
  bulkDelete(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(bulkDeleteMailMessagesSchema))
    input: BulkDeleteMailMessagesInput,
  ) {
    return this.read.bulkDeleteMessages(user.id, input.ids);
  }

  @Post(':id/move')
  @SkipPermissions()
  move(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(moveMailMessageSchema)) input: MoveMailMessageInput,
  ) {
    return this.read.moveMessage(user.id, id, input);
  }

  @Post('send')
  @SkipPermissions()
  async create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(sendMailMessageSchema)) input: SendMailMessageInput,
  ) {
    const outbox = await this.send.enqueue(user.id, input);
    return {
      id: outbox.id,
      status: outbox.status,
      createdAt: outbox.createdAt,
    };
  }

  @Post('drafts')
  @SkipPermissions()
  saveDraft(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(saveMailDraftSchema)) input: SaveMailDraftInput,
  ) {
    return this.send.saveDraft(user.id, input);
  }

  @Delete('drafts/:id')
  @SkipPermissions()
  async discardDraft(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.send.deleteDraft(user.id, id);
    return { ok: true };
  }

  /**
   * Stream a single attachment. Bytes are fetched live from IMAP since we
   * don't cache them at sync time; the round-trip is acceptable for the
   * low click-rate this endpoint sees in practice.
   */
  @Get(':id/attachments/:attachmentId')
  @SkipPermissions()
  async downloadAttachment(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('attachmentId', new ZodValidationPipe(cuid)) attachmentId: string,
    @Res() res: Response,
  ) {
    const att = await this.prisma.client.mailAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        message: { include: { account: true, folder: true } },
      },
    });
    if (!att || att.messageId !== id) {
      throw new NotFoundException({ title: 'Attachment not found', status: 404 });
    }
    if (att.message.account.userId !== user.id) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }

    // If the row is linked to a FileObject (drafts always, sent mail when
    // the worker stored a copy), stream directly from object storage -
    // no IMAP roundtrip. This is what makes draft attachment downloads
    // work at all (the IMAP draft may exist but fetching individual MIME
    // parts of an unsent draft is fragile on some servers).
    let content: Buffer | null = null;
    if (att.fileObjectId) {
      const blob = await this.send.fetchFileObjectBytes(att.fileObjectId);
      if (blob) content = blob.content;
    }
    if (!content) {
      const result = await this.sync.fetchAttachment(
        att.message.accountId,
        att.message.folder.path,
        att.message.uid,
        att.partId,
        {
          filename: att.filename,
          contentType: att.contentType,
          contentId: att.contentId,
        },
      );
      content = result.content;
      // Self-heal the stored partId (legacy Content-ID bug) so the next
      // download for this attachment takes the fast direct path.
      if (result.healedPartId && result.healedPartId !== att.partId) {
        await this.prisma.client.mailAttachment
          .update({
            where: { id: att.id },
            data: { partId: result.healedPartId },
          })
          .catch(() => undefined);
      }
    }
    if (!content) {
      throw new NotFoundException({ title: 'Attachment payload unavailable', status: 404 });
    }

    // `isInline` comes straight from the sender's MIME headers, so it is
    // attacker-controlled. Only raster images may render inline; anything
    // else (text/html, image/svg+xml, ...) is forced to download so it can
    // never execute on the API origin with the user's cookie attached.
    const serveInline = att.isInline && isSafeInlineImage(att.contentType);
    res.setHeader(
      'Content-Type',
      serveInline ? att.contentType : att.contentType || 'application/octet-stream',
    );
    // RFC 6266: a quoted ASCII `filename` for old clients plus an RFC 5987
    // `filename*` carrying the real UTF-8 name. Percent-encoding the quoted
    // form (the previous shape) is not legal there - clients take it
    // literally, so "My Report.pdf" saved as "My%20Report.pdf".
    const asciiName = att.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader(
      'Content-Disposition',
      `${serveInline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(content);
  }
}
