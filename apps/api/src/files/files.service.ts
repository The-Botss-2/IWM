import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Prisma } from '@botss/database';
import type {
  ConfirmUploadInput,
  ListFilesQuery,
  PresignUploadInput,
  PresignUploadResponse,
} from '@botss/shared-types';
import { isSafeInlineImage } from '@botss/shared-types';
import type { AppAbility } from '@botss/auth';

import { abilityRow } from '../common/permissions/request-ability';
import { isSupportRequest } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

/** Upper bound for a single upload. Overridable per deployment. */
const MAX_UPLOAD_BYTES = (() => {
  const parsed = Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 250 * 1024 * 1024;
})();

function tooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException({
    title: 'File too large',
    status: 413,
    detail: `Files must be ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`,
  });
}

/**
 * Which FileObjects the general `/files` surface (list + get) may show.
 *
 * - Signature artifacts (a signer's signature image, the frozen and the
 *   sealed PDF) are only served through the signature request, which checks
 *   document access.
 * - Cached inbound mail attachments belong to someone's private mailbox and
 *   are served through the mail module, which checks account ownership.
 * - Money artifacts (expense receipts, rendered invoice PDFs) are finance
 *   data: only callers with `hasFinanceAccess` see them here, the same gate
 *   the finance module applies. Payslips are rendered on demand and never
 *   stored as FileObjects, so there is nothing payroll-specific to hide.
 *
 * Typed so the relation names are checked at compile time.
 */
export function generalFileVisibility(financeAccess: boolean): Prisma.FileObjectWhereInput {
  return {
    signatureImages: { none: {} },
    signatureSources: { none: {} },
    signatureSealed: { none: {} },
    mailAttachments: { none: {} },
    ...(financeAccess
      ? // A read only support session sees finance, never payroll: receipts
        // of salary expenses stay hidden.
        isSupportRequest()
        ? { expenseReceipts: { none: { category: 'SALARY' } } }
        : {}
      : { expenseReceipts: { none: {} }, invoicePdfs: { none: {} } }),
  };
}

/**
 * File metadata + presigned upload flow against an S3-compatible store.
 * Locally that's MinIO on `S3_ENDPOINT`; in production it's Cloudflare R2.
 * Binaries never live in the DB - only the row in `FileObject` holds metadata.
 *
 * Public-URL modes:
 *  - **Path-style** (`S3_PUBLIC_URL_INCLUDES_BUCKET=true`, default for MinIO):
 *    `https://<host>/<bucket>/<objectKey>`. Used when one S3 host serves
 *    multiple buckets via path routing - what MinIO and the R2 raw S3 API do.
 *  - **Virtual-host / custom-domain style** (`S3_PUBLIC_URL_INCLUDES_BUCKET=false`):
 *    `https://<bucket-subdomain>/<objectKey>`. Used when a custom CNAME maps
 *    directly to one R2 bucket (e.g. `files.example.com` → the
 *    `botss-files` R2 bucket). In this mode the bucket segment is dropped
 *    from the path or downloads 404.
 *
 * If you migrate from MinIO to R2 with a custom domain, run
 * `prisma/update-urls.ts` to rewrite existing rows the same way.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  /** When true, the public URL keeps `/<bucket>/` in the path. When
   *  false, the bucket is assumed to be implied by the public hostname
   *  (custom-domain R2 pattern) and the path is just `/<objectKey>`. */
  private readonly publicUrlIncludesBucket: boolean;

  constructor(private readonly prisma: PrismaService) {
    this.bucket = process.env.S3_BUCKET ?? 'botss-files';
    this.endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9100';
    // Default `true` to preserve MinIO-compatible URLs for anyone who
    // doesn't set the flag. Production R2-with-custom-domain deployments
    // should set this to `false` explicitly.
    this.publicUrlIncludesBucket =
      (process.env.S3_PUBLIC_URL_INCLUDES_BUCKET ?? 'true').toLowerCase() !==
      'false';
    this.s3 = new S3Client({
      // Path-style addressing keeps MinIO + R2 happy with a single config; the
      // virtual-host style requires DNS routing that local dev doesn't have.
      endpoint: this.endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'botss-local',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'botss-local-secret',
      },
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
      // AWS SDK v3 (>=3.729) auto-injects an `x-amz-checksum-crc32` query
      // parameter into presigned PUT URLs, computed from the request body
      // at sign time. Presigned URLs are signed BEFORE the actual upload,
      // so the SDK computes `CRC32(<empty>)` = `AAAAAA==`. Then the browser
      // PUTs the real bytes and MinIO/R2 rejects with HTTP 400 because the
      // observed checksum doesn't match the one embedded in the URL.
      //
      // Pinning `requestChecksumCalculation` to `WHEN_REQUIRED` opts out
      // of the new auto-checksum behaviour for ops that don't explicitly
      // ask for one. Voice-note + image + arbitrary file uploads start
      // working again.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Chat attachments (direct messages included) are FileObjects uploaded
   * through the normal flow, linked only by URL. A read only support session
   * never sees chat, so it never sees these files either. Normal requests
   * are unaffected.
   */
  private async supportHiddenChatFileIds(workspaceId: string): Promise<string[]> {
    if (!isSupportRequest()) return [];
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>`
      SELECT f."id" FROM "FileObject" f
      WHERE f."workspaceId" = ${workspaceId}
        AND f."url" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "ChatAttachment" a WHERE a."fileUrl" = f."url")`;
    return rows.map((r) => r.id);
  }

  /** A support request may not open a file that is a chat attachment. */
  private async assertNotSupportChatFile(url: string | null): Promise<void> {
    if (!isSupportRequest()) return;
    if (!url) return;
    const hit = await this.prisma.client.chatAttachment.findFirst({
      where: { fileUrl: url },
      select: { id: true },
    });
    if (hit) throw new NotFoundException({ title: 'File not found', status: 404 });
  }

  async list(workspaceId: string, q: ListFilesQuery, opts: { financeAccess: boolean }) {
    const where: Prisma.FileObjectWhereInput = {
      workspaceId,
      ...generalFileVisibility(opts.financeAccess),
    };
    const hiddenIds = await this.supportHiddenChatFileIds(workspaceId);
    if (hiddenIds.length > 0) where['id'] = { notIn: hiddenIds };
    if (q.kind) where['kind'] = q.kind;
    if (q.search) where['filename'] = { contains: q.search, mode: 'insensitive' };

    const skip = (q.page - 1) * q.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.fileObject.findMany({
        where,
        skip,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
      }),
      this.prisma.client.fileObject.count({ where }),
    ]);
    return {
      items: items.map((f) => ({ ...f, sizeBytes: f.sizeBytes.toString() })),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  /** Same visibility as `list`: a hidden artifact is a 404 here too. */
  async get(workspaceId: string, id: string, opts: { financeAccess: boolean }) {
    const file = await this.prisma.client.fileObject.findFirst({
      where: { id, workspaceId, ...generalFileVisibility(opts.financeAccess) },
    });
    if (!file) throw new NotFoundException({ title: 'File not found', status: 404 });
    await this.assertNotSupportChatFile(file.url);
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async presign(
    workspaceId: string,
    input: PresignUploadInput,
  ): Promise<PresignUploadResponse> {
    // Random key prefixed by workspace so a presigned URL can't be replayed
    // against another tenant's prefix even if the URL leaks. NOTE: reads are
    // NOT signed today. `confirmUpload` stores a plain public URL, so the
    // bucket must allow public reads and the random key is the only secret.
    // Moving to signed reads needs every stored URL rewritten (tracked as a
    // separate project).
    if (input.sizeBytes > MAX_UPLOAD_BYTES) throw tooLarge();
    const id = randomBytes(9).toString('base64url');
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const objectKey = `workspaces/${workspaceId}/${id}-${safeName}`;
    const expiresIn = 600; // 10 minutes

    // Uploads are now unrestricted (any file type, WhatsApp-style), so the
    // serve-time disposition is the primary defence against stored-XSS. Only
    // SAFE RASTER images (png/jpeg/gif/webp/...) get `inline` so the editor /
    // chat can render them via <img src=...>. Everything else - crucially
    // including SVG (scriptable XML) and HTML - is forced to download, where
    // it cannot execute in our origin. `isSafeInlineImage` is the single
    // source of truth shared with the web client.
    const safeAsciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
    const contentDisposition = isSafeInlineImage(input.mimeType)
      ? `inline; filename="${safeAsciiName}"`
      : `attachment; filename="${safeAsciiName}"`;

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: input.mimeType,
        ContentLength: input.sizeBytes,
        ContentDisposition: contentDisposition,
      });
      let uploadUrl = await getSignedUrl(this.s3, command, { expiresIn });

      // If a public URL is configured, rewrite the upload URL host so the client uploads to the public endpoint
      if (process.env.S3_PUBLIC_URL) {
        const publicUrlBase = process.env.S3_PUBLIC_URL.replace(/\/+$/, '');
        const internalUrlBase = this.endpoint.replace(/\/+$/, '');
        uploadUrl = uploadUrl.replace(internalUrlBase, publicUrlBase);
      }

      return {
        uploadUrl,
        objectKey,
        bucket: this.bucket,
        // The client must echo every header the signature covers. AWS SDK
        // adds `content-disposition` to the signed-headers list because we
        // pass `ContentDisposition` on the PutObjectCommand - without
        // returning the exact same value here, the browser's PUT lacks the
        // header, the signature doesn't match, and MinIO/R2 reject with
        // HTTP 400 (the voice-note upload symptom). `Content-Length` is
        // auto-set by `fetch` from `body: file`, so we don't surface it
        // explicitly; the browser sets it correctly without our help.
        headers: {
          'Content-Type': input.mimeType,
          'Content-Disposition': contentDisposition,
        },
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    } catch (err) {
      this.logger.error('Failed to presign upload', err as Error);
      throw new InternalServerErrorException({
        title: 'Upload unavailable',
        status: 500,
        detail: "Couldn't prepare the upload. Try again in a moment.",
      });
    }
  }

  async confirmUpload(workspaceId: string, userId: string, input: ConfirmUploadInput) {
    // The key we presign is always `workspaces/<workspaceId>/...` in our own
    // bucket. Reject anything else so a member can't register a FileObject
    // pointing at another tenant's object (or an arbitrary bucket/key).
    if (
      !input.objectKey.startsWith(`workspaces/${workspaceId}/`) ||
      input.bucket !== this.bucket
    ) {
      throw new ForbiddenException({
        title: 'Invalid upload reference',
        status: 403,
        detail: 'The object key or bucket does not belong to your workspace.',
      });
    }
    // Trust the bucket, not the client. The size and type the browser reports
    // were recorded verbatim, so an object presigned as text/html could be
    // confirmed as image/png (and render inline), and any size limit was a
    // suggestion. HEAD the real object and record what is actually stored.
    let head: { ContentLength?: number; ContentType?: string };
    try {
      head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: input.objectKey }),
      );
    } catch {
      throw new BadRequestException({
        title: 'Upload not found',
        status: 400,
        detail: 'The file was not uploaded, or the upload expired. Please try again.',
      });
    }
    const storedSize = head.ContentLength ?? input.sizeBytes;
    if (storedSize > MAX_UPLOAD_BYTES) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.objectKey }))
        .catch(() => undefined);
      throw tooLarge();
    }
    const storedMime = head.ContentType?.trim() || input.mimeType;

    const created = await this.prisma.client.fileObject.create({
      data: {
        workspaceId,
        uploadedById: userId,
        bucket: this.bucket,
        objectKey: input.objectKey,
        // The object key is enough to fetch via the S3 SDK or via a future
        // signed-read endpoint. Stashing a direct URL here too means clients
        // (e.g. the editor's <img>) can render without a second round-trip.
        url: this.publicUrl(this.bucket, input.objectKey),
        filename: input.filename,
        mimeType: storedMime,
        sizeBytes: BigInt(storedSize),
        kind: input.kind ?? 'OTHER',
        ...(input.checksum !== undefined ? { checksum: input.checksum } : {}),
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      },
    });
    return { ...created, sizeBytes: created.sizeBytes.toString() };
  }

  /**
   * Store bytes the server produced itself (rendered invoice PDFs) and record
   * the FileObject, using the same key convention and disposition rules as a
   * browser upload.
   */
  async putBuffer(args: {
    workspaceId: string;
    uploadedById: string;
    filename: string;
    mimeType: string;
    body: Buffer;
    kind?: 'PDF' | 'IMAGE' | 'OTHER';
  }) {
    const id = randomBytes(9).toString('base64url');
    const safeName = args.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const objectKey = `workspaces/${args.workspaceId}/${id}-${safeName}`;
    const safeAsciiName = safeName.replace(/[^ -~]/g, '_');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: args.body,
        ContentType: args.mimeType,
        ContentLength: args.body.byteLength,
        ContentDisposition: isSafeInlineImage(args.mimeType)
          ? `inline; filename="${safeAsciiName}"`
          : `attachment; filename="${safeAsciiName}"`,
      }),
    );
    const created = await this.prisma.client.fileObject.create({
      data: {
        workspaceId: args.workspaceId,
        uploadedById: args.uploadedById,
        bucket: this.bucket,
        objectKey,
        url: this.publicUrl(this.bucket, objectKey),
        filename: args.filename,
        mimeType: args.mimeType,
        sizeBytes: BigInt(args.body.byteLength),
        kind: args.kind ?? 'OTHER',
      },
    });
    return { ...created, sizeBytes: created.sizeBytes.toString() };
  }

  /**
   * Matches this store's object URLs (the public base and the internal
   * endpoint, path style or not) wherever they appear in a string; group 1
   * is `workspaces/...` up to the end of the link, query string included.
   * Used to rewrite file links in support session responses.
   */
  fileUrlPattern(): RegExp | null {
    const bases = [
      ...new Set(
        [process.env.S3_PUBLIC_URL, this.endpoint]
          .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
          .map((b) => b.trim().replace(/\/+$/, '')),
      ),
    ];
    if (bases.length === 0) return null;
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(?:${bases.map(esc).join('|')})/(?:${esc(this.bucket)}/)?(workspaces/[^\\s"'<>()\\\\]*)`,
      'gi',
    );
  }

  /**
   * Open a stored object for `GET /files/:id/content`: the workspaces the
   * controller allows (see `contentWorkspaceIds`), the same
   * visibility as `list`/`get`. Hidden or missing is a 404.
   */
  async openContent(
    workspaceIds: readonly string[],
    id: string,
    opts: { financeAccess: boolean },
  ): Promise<{ stream: Readable; mimeType: string; filename: string; size: number | null }> {
    const notFound = () => new NotFoundException({ title: 'File not found', status: 404 });
    if (workspaceIds.length === 0) throw notFound();
    const file = await this.prisma.client.fileObject.findFirst({
      where: { id, workspaceId: { in: [...workspaceIds] }, ...generalFileVisibility(opts.financeAccess) },
      select: { bucket: true, objectKey: true, mimeType: true, filename: true, url: true },
    });
    if (!file) throw notFound();
    await this.assertNotSupportChatFile(file.url);
    let res;
    try {
      res = await this.s3.send(new GetObjectCommand({ Bucket: file.bucket, Key: file.objectKey }));
    } catch (err) {
      this.logger.warn(`File content read failed id=${id} message=${(err as Error)?.message ?? 'unknown'}`);
      throw notFound();
    }
    const body = res.Body as unknown as Readable | undefined;
    if (!body) throw notFound();
    return {
      stream: body,
      mimeType: file.mimeType,
      filename: file.filename,
      size: typeof res.ContentLength === 'number' ? res.ContentLength : null,
    };
  }

  /** Read a stored object's bytes (logos for invoice rendering, PDFs for email). */
  async getObjectBuffer(
    workspaceId: string,
    fileId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<{ body: Buffer; mimeType: string; filename: string } | null> {
    // `includeDeleted`: a signature request's frozen PDF must stay readable
    // even if someone removes the FileObject from the Files list.
    const file = await (this.prisma.client.fileObject.findFirst as unknown as (
      args: unknown,
    ) => Promise<{ bucket: string; objectKey: string; mimeType: string; filename: string } | null>)({
      where: { id: fileId, workspaceId },
      select: { bucket: true, objectKey: true, mimeType: true, filename: true },
      ...(opts.includeDeleted ? { includeDeleted: true } : {}),
    });
    if (!file) return null;
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: file.bucket, Key: file.objectKey }),
    );
    const stream = res.Body as AsyncIterable<Uint8Array> | undefined;
    if (!stream) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { body: Buffer.concat(chunks), mimeType: file.mimeType, filename: file.filename };
  }

  /**
   * Row-level delete: the uploader (files.upload grants `delete FileObject
   * { uploadedById: me }`) or `files.manage_all`. PermissionsGuard only saw
   * the bare subject, which every uploader holds.
   */
  async remove(
    workspaceId: string,
    ability: AppAbility,
    id: string,
    opts: { financeAccess: boolean },
  ) {
    const file = await this.get(workspaceId, id, opts);
    if (!ability.can('delete', abilityRow('FileObject', file))) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only the person who uploaded this file, or someone who manages all files, can delete it.',
        code: 'insufficient_permissions',
      });
    }
    await this.prisma.client.fileObject.delete({ where: { id } });
  }

  /**
   * Build the public-read URL for a stored object. Two shapes:
   *  - Path-style (`<host>/<bucket>/<key>`) - MinIO local and any S3 host
   *    that serves multiple buckets at the same domain.
   *  - Virtual-host / custom-domain style (`<host>/<key>`) - when the
   *    public hostname is already pinned to ONE bucket via a custom CNAME
   *    (the R2 + `bucket.example.com` pattern). Including the bucket in
   *    the path here returns 404, which is the "File wasn't available on
   *    site" symptom historic FileObject rows hit after the MinIO →
   *    R2 migration.
   */
  private publicUrl(bucket: string, objectKey: string): string {
    const base = (process.env.S3_PUBLIC_URL || this.endpoint).replace(/\/+$/, '');
    if (this.publicUrlIncludesBucket) {
      return `${base}/${bucket}/${encodeURI(objectKey)}`;
    }
    return `${base}/${encodeURI(objectKey)}`;
  }
}
