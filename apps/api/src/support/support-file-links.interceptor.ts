import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { from, mergeMap, type Observable } from 'rxjs';

import type { RequestExtensions } from '../common/guards/auth.guard';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { collectFileLinkKeys, rewriteFileLinks, supportFileContentUrl } from './support-file-links';

/**
 * Global interceptor, a no-op unless the request runs in a read only support
 * session. Then every stored file link in the JSON response is rewritten to
 * the guarded `GET /files/:id/content` route (see `support-file-links.ts`).
 * Binary and streamed responses are left alone.
 */
@Injectable()
export class SupportFileLinksInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<RequestExtensions>();
    const token = req.support ? req.supportToken : undefined;
    if (!token) return next.handle();
    const workspaceIds = (req.workspaceMemberships ?? []).map((m) => m.workspaceId);
    return next
      .handle()
      .pipe(mergeMap((body: unknown) => from(this.rewrite(body, token, workspaceIds))));
  }

  private async rewrite(body: unknown, token: string, workspaceIds: string[]): Promise<unknown> {
    if (
      body === null ||
      body === undefined ||
      body instanceof StreamableFile ||
      Buffer.isBuffer(body)
    ) {
      return body;
    }
    const pattern = this.files.fileUrlPattern();
    if (!pattern) return body;
    const { found, keys } = collectFileLinkKeys(body, pattern);
    if (!found) return body;
    const idByKey = new Map<string, string>();
    if (keys.size > 0 && workspaceIds.length > 0) {
      const rows = await this.prisma.client.fileObject.findMany({
        where: { objectKey: { in: [...keys] }, workspaceId: { in: workspaceIds } },
        select: { id: true, objectKey: true },
      });
      for (const r of rows) idByKey.set(r.objectKey, r.id);
    }
    const apiOrigin = process.env.BETTER_AUTH_URL ?? 'http://localhost:4000';
    const apiBasePath = process.env.API_BASE_PATH ?? 'api/v1';
    return rewriteFileLinks(body, pattern, (key) =>
      supportFileContentUrl({
        apiOrigin,
        apiBasePath,
        fileId: key ? (idByKey.get(key) ?? null) : null,
        token,
      }),
    );
  }
}
