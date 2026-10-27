import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  confirmUploadSchema,
  type ConfirmUploadInput,
  cuid,
  listFilesQuerySchema,
  type ListFilesQuery,
  presignUploadSchema,
  type PresignUploadInput,
  isSafeInlineImage,
} from '@botss/shared-types';

import type { AppAbility } from '@botss/auth';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { HasFinanceAccess } from '../common/decorators/finance-access.decorator';
import { RequestAbility } from '../common/decorators/request-ability.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { SupportTokenInQuery } from '../common/decorators/support-token-query.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @RequireAbility('read', 'FileObject')
  list(
    @CurrentWorkspaceId() workspaceId: string,
    @HasFinanceAccess() financeAccess: boolean,
    @Query(new ZodValidationPipe(listFilesQuerySchema)) q: ListFilesQuery,
  ) {
    return this.files.list(workspaceId, q, { financeAccess });
  }

  @Get(':id')
  @RequireAbility('read', 'FileObject')
  get(
    @CurrentWorkspaceId() workspaceId: string,
    @HasFinanceAccess() financeAccess: boolean,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.files.get(workspaceId, id, { financeAccess });
  }

  /**
   * The file's bytes, through AuthGuard: the active workspace (a support
   * session: its granted workspaces, see `contentWorkspaceIds`), the same
   * visibility as `GET /files/:id`, never cached. A read only
   * support session's responses link files here instead of to the public
   * object URL, so each open is logged and stops working when the grant
   * ends. Binary output, so there is no response schema to apply.
   */
  @Get(':id/content')
  @RequireAbility('read', 'FileObject')
  @SupportTokenInQuery()
  async content(
    @Req() req: RequestExtensions,
    @HasFinanceAccess() financeAccess: boolean,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const workspaceIds = contentWorkspaceIds(req);
    const file = await this.files.openContent(workspaceIds, id, { financeAccess });
    const inlineType = inlineContentType(file.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The link may carry a support token; never pass it on as a Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Served from the API origin: never let a stored document run script.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    return new StreamableFile(file.stream, {
      type: inlineType ?? 'application/octet-stream',
      disposition: contentDisposition(inlineType ? 'inline' : 'attachment', file.filename),
      ...(file.size !== null ? { length: file.size } : {}),
    });
  }

  @Post('presign')
  @RequireAbility('create', 'FileObject')
  presign(
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(presignUploadSchema)) input: PresignUploadInput,
  ) {
    return this.files.presign(workspaceId, input);
  }

  @Post('confirm')
  @RequireAbility('create', 'FileObject')
  confirm(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(confirmUploadSchema)) input: ConfirmUploadInput,
  ) {
    return this.files.confirmUpload(workspaceId, user.id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'FileObject')
  async remove(
    @CurrentWorkspaceId() workspaceId: string,
    @RequestAbility() ability: AppAbility,
    @HasFinanceAccess() financeAccess: boolean,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.files.remove(workspaceId, ability, id, { financeAccess });
    return { ok: true };
  }
}

/**
 * Workspaces `GET /files/:id/content` may read from. A support session reads
 * across its granted workspaces (an `<img>` can't send the workspace header);
 * a normal request only the active workspace PermissionsGuard checked.
 */
export function contentWorkspaceIds(
  req: Pick<RequestExtensions, 'support' | 'workspaceId' | 'workspaceMemberships'>,
): string[] {
  if (req.support) return (req.workspaceMemberships ?? []).map((m) => m.workspaceId);
  return req.workspaceId ? [req.workspaceId] : [];
}

const INLINE_MEDIA_TYPE = /^(audio|video)\/[a-z0-9][a-z0-9.+-]{0,100}$/;

/**
 * The normalized type to serve a file inline with (safe images, PDFs, audio
 * and video), or null to force a download. Never the raw stored mimeType:
 * it is caller supplied and could carry parameters or header breaking bytes.
 */
export function inlineContentType(mimeType: string | null | undefined): string | null {
  const m = (mimeType ?? '').trim().toLowerCase();
  if (isSafeInlineImage(m) || m === 'application/pdf' || INLINE_MEDIA_TYPE.test(m)) return m;
  return null;
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
