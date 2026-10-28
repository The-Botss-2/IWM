import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type SignatureSigner as SignerRow } from '@botss/database';
import {
  type CancelSignatureRequestInput,
  type ClientHubPageQuery,
  clientSignatureListSchema,
  type ClientSignatureList,
  type CreateSignatureRequestInput,
  type DeclinePublicInput,
  type ListSignatureRequestsQuery,
  portalSignatureListSchema,
  type PortalSignatureList,
  type PublicSignatureSession,
  publicSignatureSessionSchema,
  type SendSignatureRequestInput,
  type SetSignatureFieldsInput,
  type SignatureRequestDetails,
  signatureRequestDetailsSchema,
  type SignatureRequestList,
  signatureRequestListSchema,
  type SigningLinksResponse,
  signingLinksResponseSchema,
  type SignPublicInput,
  type SignPublicResponse,
  signPublicResponseSchema,
} from '@botss/shared-types';
import type { Queue } from 'bullmq';

import { DocumentsService } from '../documents/documents.service';
import { EmailService } from '../email/email.service';
import { FilesService, generalFileVisibility } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  clientSignatureRelationWhere,
  decodeCursor,
  encodeCursor,
  keysetWhere,
} from '../clients/client-hub-rules';
import { requireVisibleClient } from '../clients/client-visibility';
import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { decodeSignaturePng } from './signature-image';
import { signatureVisibleWhere } from './signature-visibility';
import { MAX_SOURCE_PDF_BYTES, SignaturePdfService } from './signature-pdf.service';
import { SEAL_JOB_OPTIONS, sealJobId, type SealJobData, SIGNATURES_QUEUE } from './signature.queue';
import {
  accessCodeMatches,
  attemptsExhausted,
  MAX_ACCESS_CODE_ATTEMPTS,
} from '../common/access-code';
import {
  hashSigningToken,
  newSigningCredentials,
  sha256Hex,
  signingUrl,
  unusableTokenHash,
} from './token';

/** Who is acting, resolved from the request by the controller. */
export interface SignatureActor {
  userId: string;
  workspaceId: string;
  workspaceRole: string | undefined;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** How a signer reached the signing surface: the emailed link, or the client
 *  portal while signed in. Recorded on the audit trail. */
export type SignerVia = 'link' | 'portal';

/**
 * A client-portal person's OWN signer row. Matched by id AND their account
 * email, on a request inside their client's workspace, so a portal person
 * can never reach someone else's signing slot by guessing an id.
 */
export interface PortalSignerRef {
  signerId: string;
  email: string;
  workspaceId: string;
  userId: string;
}

const DETAILS_INCLUDE = {
  createdBy: { select: { id: true, name: true, email: true, image: true } },
  signers: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
  fields: { orderBy: [{ page: 'asc' }, { y: 'asc' }] },
  events: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SignatureRequestInclude;

type RequestWithDetails = Prisma.SignatureRequestGetPayload<{ include: typeof DETAILS_INCLUDE }>;

const SUMMARY_INCLUDE = {
  createdBy: { select: { id: true, name: true, email: true, image: true } },
  signers: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.SignatureRequestInclude;

/** Cursor source key for the client Signatures tab (single-source keyset). */
const CLIENT_SIGNATURE_SOURCE = 'signature';

/** Resends per signer per 24 hours; each one emails a fresh link. */
const MAX_RESENDS_PER_DAY = 5;
/** Sign/decline attempts per IP per hour, on top of the Express limiter. */
const MAX_PUBLIC_WRITES_PER_HOUR = 20;

const SIGNER_REQUEST_INCLUDE = {
  workspace: { select: { name: true, organizationId: true } },
  createdBy: { select: { name: true, email: true } },
  signers: { select: { id: true, status: true } },
  fields: true,
} as const;

/** A signer and their request, however the signer was identified. */
interface SignerContext {
  signer: SignerRow;
  request: Prisma.SignatureRequestGetPayload<{ include: typeof SIGNER_REQUEST_INCLUDE }>;
}

/** Extra audit-trail fields for events written through the portal. */
function viaTrail(via: SignerVia, userId?: string): Record<string, string> {
  return via === 'portal' && userId ? { via, userId } : {};
}

@Injectable()
export class SignaturesService {
  private readonly logger = new Logger(SignaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly pdf: SignaturePdfService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    @InjectQueue(SIGNATURES_QUEUE) private readonly queue: Queue<SealJobData>,
  ) {}

  // =========================================================================
  // Requester side
  // =========================================================================

  /** Freeze the PDF and create a DRAFT with its signers. */
  async create(
    actor: SignatureActor,
    input: CreateSignatureRequestInput,
  ): Promise<SignatureRequestDetails> {
    let title = input.title?.trim() || '';
    if (input.documentId) {
      await this.documents.assertAccess(
        actor.workspaceId,
        input.documentId,
        this.docCtx(actor),
        'write',
      );
      if (!title) {
        const doc = await this.prisma.client.document.findFirst({
          where: { id: input.documentId, workspaceId: actor.workspaceId },
          select: { title: true },
        });
        title = doc?.title ?? '';
      }
    }

    let bytes: Buffer;
    if (input.sourceFileId) {
      const file = await this.prisma.client.fileObject.findFirst({
        where: {
          id: input.sourceFileId,
          workspaceId: actor.workspaceId,
          ...generalFileVisibility(false),
        },
        select: { id: true, mimeType: true, filename: true, sizeBytes: true },
      });
      if (!file) throw new NotFoundException({ title: 'File not found', status: 404 });
      if (file.mimeType.toLowerCase() !== 'application/pdf') {
        throw new UnprocessableEntityException({
          title: 'Not a PDF',
          status: 422,
          detail: 'Only PDF files can be sent for signature.',
        });
      }
      if (file.sizeBytes > BigInt(MAX_SOURCE_PDF_BYTES)) {
        throw new UnprocessableEntityException({
          title: 'PDF too large',
          status: 422,
          detail: 'PDFs up to 25 MB can be sent for signature.',
        });
      }
      const obj = await this.files.getObjectBuffer(actor.workspaceId, file.id);
      if (!obj) throw new NotFoundException({ title: 'File not found', status: 404 });
      bytes = obj.body;
      if (!title) title = file.filename.replace(/\.pdf$/i, '');
    } else {
      bytes = await this.pdf.renderDocument(actor.workspaceId, input.documentId!);
    }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new UnprocessableEntityException({
        title: 'Not a PDF',
        status: 422,
        detail: 'The file does not look like a PDF.',
      });
    }
    title = (title || 'Untitled document').slice(0, 200);

    const { pageCount } = await this.pdf.inspect(bytes);
    const sourceSha256 = sha256Hex(bytes);

    // The frozen copy is always a new object, even for an uploaded PDF, so
    // replacing or deleting the original file never changes what was signed.
    const stored = await this.files.putBuffer({
      workspaceId: actor.workspaceId,
      uploadedById: actor.userId,
      filename: `${safeFilename(title)}.pdf`,
      mimeType: 'application/pdf',
      body: bytes,
      kind: 'PDF',
    });
    await this.prisma.client.fileObject.update({
      where: { id: stored.id },
      data: { checksum: sourceSha256 },
    });

    const created = await this.prisma.client.signatureRequest.create({
      data: {
        workspaceId: actor.workspaceId,
        createdById: actor.userId,
        documentId: input.documentId ?? null,
        sourceFileId: stored.id,
        title,
        status: 'DRAFT',
        // Placeholder; send() sets the real expiry.
        expiresAt: addDays(new Date(), 14),
        sourceSha256,
        pageCount,
        signers: {
          create: input.signers.map((s, i) => ({
            email: s.email,
            name: s.name?.trim() || null,
            order: i,
            tokenHash: unusableTokenHash(),
          })),
        },
        events: { create: { kind: 'CREATED', metadata: { byUserId: actor.userId } } },
      },
      include: DETAILS_INCLUDE,
    });
    return toDetails(created);
  }

  async list(actor: SignatureActor, q: ListSignatureRequestsQuery): Promise<SignatureRequestList> {
    const where: Prisma.SignatureRequestWhereInput = { workspaceId: actor.workspaceId };
    if (q.status) where.status = q.status;
    if (q.documentId) {
      // Anyone who can read the document sees its requests.
      await this.documents.assertAccess(
        actor.workspaceId,
        q.documentId,
        this.docCtx(actor),
        'read',
      );
      where.documentId = q.documentId;
    } else if (!isWorkspaceAdmin(actor)) {
      where.createdById = actor.userId;
    }
    const rows = await this.prisma.client.signatureRequest.findMany({
      where,
      include: SUMMARY_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return signatureRequestListSchema.parse({
      items: rows.map((r) => ({
        ...baseRequest(r),
        status: effectiveStatus(r.status, r.expiresAt, r.signers),
        createdBy: r.createdBy,
        signers: r.signers,
      })),
    });
  }

  async get(actor: SignatureActor, id: string): Promise<SignatureRequestDetails> {
    const row = await this.loadForView(actor, id);
    return toDetails(row);
  }

  /** Replace the fields of a DRAFT. */
  async setFields(
    actor: SignatureActor,
    id: string,
    input: SetSignatureFieldsInput,
  ): Promise<SignatureRequestDetails> {
    const row = await this.loadForManage(actor, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException({
        title: 'Already sent',
        status: 409,
        detail: 'Fields can only be changed before the request is sent.',
      });
    }
    const signerIds = new Set(row.signers.map((s) => s.id));
    for (const f of input.fields) {
      if (!signerIds.has(f.signerId)) {
        throw new BadRequestException({
          title: 'Unknown signer',
          status: 400,
          detail: 'A field belongs to a signer who is not on this request.',
        });
      }
      if (f.page > row.pageCount) {
        throw new BadRequestException({
          title: 'Page out of range',
          status: 400,
          detail: `The document has ${row.pageCount} page(s).`,
        });
      }
    }
    await this.prisma.client.$transaction([
      this.prisma.client.signatureField.deleteMany({ where: { requestId: id } }),
      this.prisma.client.signatureField.createMany({
        data: input.fields.map((f) => ({
          requestId: id,
          signerId: f.signerId,
          kind: f.kind,
          page: f.page,
          x: f.x,
          y: f.y,
          w: Math.min(f.w, 1 - f.x),
          h: Math.min(f.h, 1 - f.y),
        })),
      }),
    ]);
    return this.get(actor, id);
  }

  /** Email the signers. Every signer gets a fresh link. */
  async send(
    actor: SignatureActor,
    id: string,
    input: SendSignatureRequestInput,
  ): Promise<SigningLinksResponse> {
    const row = await this.loadForManage(actor, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException({
        title: 'Already sent',
        status: 409,
        detail: 'This request was already sent. Use resend for a single signer.',
      });
    }
    const now = new Date();
    const expiresAt = addDays(now, input.expiresInDays);
    const tokens = row.signers.map((s) => ({ signer: s, ...newSigningCredentials() }));

    // Conditional on DRAFT so two concurrent sends cannot both email.
    await this.prisma.client.$transaction(async (tx) => {
      const flipped = await tx.signatureRequest.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          status: 'SENT',
          sentAt: now,
          expiresAt,
          ...(input.title ? { title: input.title } : {}),
          ...(input.message !== undefined ? { message: input.message?.trim() || null } : {}),
        },
      });
      if (flipped.count !== 1) {
        throw new ConflictException({ title: 'Already sent', status: 409 });
      }
      for (const { signer, token, code } of tokens) {
        await tx.signatureSigner.update({
          where: { id: signer.id },
          data: { ...freshLinkData(token.hash, code.hash), lastEmailedAt: now },
        });
      }
      await tx.signatureEvent.create({
        data: { requestId: id, kind: 'SENT', metadata: { byUserId: actor.userId, expiresAt } },
      });
    });

    const fresh = await this.loadDetails(id);
    const emailed = await this.emailSigners(
      fresh,
      tokens.map((t) => ({ signerId: t.signer.id, raw: t.token.raw, code: t.code.raw })),
    );
    return signingLinksResponseSchema.parse({
      request: toDetails(fresh),
      links: tokens.map((t) => ({
        signerId: t.signer.id,
        email: t.signer.email,
        url: signingUrl(t.token.raw),
        code: t.code.raw,
      })),
      emailed,
    });
  }

  /** New link for one signer. The previous link stops working. */
  async resend(actor: SignatureActor, id: string, signerId: string): Promise<SigningLinksResponse> {
    const row = await this.loadForManage(actor, id);
    if (row.status !== 'SENT') {
      throw new ConflictException({
        title: 'Not awaiting signatures',
        status: 409,
        detail: 'Only a sent request that is still open can be resent.',
      });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({ title: 'Request expired', status: 410 });
    }
    const signer = row.signers.find((s) => s.id === signerId);
    if (!signer) throw new NotFoundException({ title: 'Signer not found', status: 404 });
    if (signer.status === 'SIGNED' || signer.status === 'DECLINED') {
      throw new ConflictException({
        title: 'Nothing to resend',
        status: 409,
        detail: 'This signer has already responded.',
      });
    }
    const recent = await this.prisma.client.signatureEvent.count({
      where: {
        signerId,
        kind: 'RESENT',
        createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (recent >= MAX_RESENDS_PER_DAY) {
      throw new HttpException(
        {
          title: 'Too many resends',
          status: 429,
          detail: `A signer can be resent ${MAX_RESENDS_PER_DAY} times a day.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // A resend also unlocks a signer who ran out of code attempts: the old
    // link and code both die and a fresh pair goes to the signer's inbox.
    const { token, code } = newSigningCredentials();
    await this.prisma.client.$transaction([
      this.prisma.client.signatureSigner.update({
        where: { id: signerId },
        data: { ...freshLinkData(token.hash, code.hash), lastEmailedAt: new Date() },
      }),
      this.prisma.client.signatureEvent.create({
        data: { requestId: id, signerId, kind: 'RESENT', metadata: { byUserId: actor.userId } },
      }),
    ]);
    const fresh = await this.loadDetails(id);
    const emailed = await this.emailSigners(fresh, [{ signerId, raw: token.raw, code: code.raw }]);
    return signingLinksResponseSchema.parse({
      request: toDetails(fresh),
      links: [{ signerId, email: signer.email, url: signingUrl(token.raw), code: code.raw }],
      emailed,
    });
  }

  async cancel(
    actor: SignatureActor,
    id: string,
    input: CancelSignatureRequestInput,
  ): Promise<SignatureRequestDetails> {
    const row = await this.loadForManage(actor, id);
    if (row.status !== 'DRAFT' && row.status !== 'SENT') {
      throw new ConflictException({
        title: 'Cannot cancel',
        status: 409,
        detail: 'Only a draft or an open request can be cancelled.',
      });
    }
    const changedMeanwhile = () =>
      new ConflictException({
        title: 'Cannot cancel',
        status: 409,
        detail: 'This request changed in the meantime. Refresh to see its current state.',
      });
    await this.prisma.client.$transaction(async (tx) => {
      if (row.status === 'SENT') {
        // Serialise with any signature being written right now, then make
        // sure someone is still left to sign: once everyone has signed the
        // request only waits for its seal job, and cancelling it would leave
        // a fully signed document with no sealed PDF and dead links.
        await lockOpenRequest(tx, id, changedMeanwhile);
        const pending = await tx.signatureSigner.count({
          where: { requestId: id, status: { not: 'SIGNED' } },
        });
        if (pending === 0) {
          throw new ConflictException({
            title: 'Cannot cancel',
            status: 409,
            detail: 'Everyone has already signed. The signed PDF is being prepared.',
          });
        }
      }
      // Conditional on the state read above: if the last signer finished and
      // the seal completed in between, cancelling must fail, not overwrite.
      const flipped = await tx.signatureRequest.updateMany({
        where: { id, status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'CANCELLED' },
      });
      if (flipped.count !== 1) throw changedMeanwhile();
      await tx.signatureEvent.create({
        data: {
          requestId: id,
          kind: 'CANCELLED',
          metadata: { byUserId: actor.userId, reason: input.reason ?? null },
        },
      });
    });
    return this.get(actor, id);
  }

  /** Discard a DRAFT (the dialog was closed before sending). */
  async removeDraft(actor: SignatureActor, id: string): Promise<{ ok: true }> {
    const row = await this.loadForManage(actor, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException({
        title: 'Already sent',
        status: 409,
        detail: 'Cancel a sent request instead of deleting it; its audit trail is kept.',
      });
    }
    await this.prisma.client.signatureRequest.delete({ where: { id } });
    // The frozen PDF is a private copy made for this draft; nothing else uses it.
    await this.prisma.client.fileObject
      .delete({ where: { id: row.sourceFileId } })
      .catch(() => undefined);
    return { ok: true };
  }

  /** Re-queue sealing after a failure (all signed, no sealed file yet). */
  async retrySeal(actor: SignatureActor, id: string): Promise<SignatureRequestDetails> {
    const row = await this.loadForManage(actor, id);
    const allSigned = row.signers.every((s) => s.status === 'SIGNED');
    if (row.status !== 'SENT' || !allSigned || row.signedFileId) {
      throw new ConflictException({
        title: 'Nothing to seal',
        status: 409,
        detail: 'Sealing runs once every signer has signed.',
      });
    }
    await this.enqueueSeal(id, true);
    return toDetails(row);
  }

  async sourceFile(actor: SignatureActor, id: string) {
    const row = await this.loadForView(actor, id);
    return this.readFile(row.workspaceId, row.sourceFileId, `${safeFilename(row.title)}.pdf`);
  }

  async signedFile(actor: SignatureActor, id: string) {
    const row = await this.loadForView(actor, id);
    if (!row.signedFileId) {
      throw new NotFoundException({
        title: 'Not signed yet',
        status: 404,
        detail: 'The signed PDF exists once everyone has signed.',
      });
    }
    return this.readFile(
      row.workspaceId,
      row.signedFileId,
      `${safeFilename(row.title)} (signed).pdf`,
    );
  }

  // =========================================================================
  // Signer side. Two ways in - the emailed link (token) and the client portal
  // (signed in) - resolve to the same { signer, request }, and everything
  // after that is one implementation, so the two can never drift apart.
  // =========================================================================

  // Every link entry point takes the token from the URL AND the code the
  // signer typed (x-access-code header). resolveToken checks both.

  async session(
    token: string,
    code: string | undefined,
    client: ClientInfo,
  ): Promise<PublicSignatureSession> {
    return this.sessionFor(await this.resolveToken(token, code), client, 'link');
  }

  async publicSourceFile(token: string, code: string | undefined) {
    return this.sourceFileFor(await this.resolveToken(token, code));
  }

  async publicSignedFile(token: string, code: string | undefined) {
    return this.signedFileFor(await this.resolveToken(token, code));
  }

  async sign(
    token: string,
    code: string | undefined,
    input: SignPublicInput,
    client: ClientInfo,
  ): Promise<SignPublicResponse> {
    await this.limitWrites(`esign:rate:${client.ip ?? 'unknown'}`);
    return this.signFor(await this.resolveToken(token, code), input, client, 'link');
  }

  async decline(
    token: string,
    code: string | undefined,
    input: DeclinePublicInput,
    client: ClientInfo,
  ): Promise<{ ok: true }> {
    await this.limitWrites(`esign:rate:${client.ip ?? 'unknown'}`);
    return this.declineFor(await this.resolveToken(token, code), input, client, 'link');
  }

  // ---- Client portal ------------------------------------------------------

  /** Requests addressed to this email inside one workspace, newest first. */
  async portalList(email: string, workspaceId: string): Promise<PortalSignatureList> {
    const rows = await this.prisma.client.signatureSigner.findMany({
      where: {
        email: email.toLowerCase(),
        // Nested: the soft-delete extension only filters top-level queries.
        request: { workspaceId, deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        status: true,
        signedAt: true,
        request: {
          select: {
            title: true,
            status: true,
            sentAt: true,
            expiresAt: true,
            completedAt: true,
            createdBy: { select: { name: true } },
            signers: { select: { status: true } },
          },
        },
      },
    });
    // No VIEWED flip here: only opening a request counts as viewing it.
    return portalSignatureListSchema.parse({
      items: rows.map((r) => ({
        signerId: r.id,
        title: r.request.title,
        requesterName: r.request.createdBy.name,
        requestStatus: effectiveStatus(r.request.status, r.request.expiresAt, r.request.signers),
        signerStatus: r.status,
        sentAt: r.request.sentAt,
        expiresAt: r.request.expiresAt,
        signedAt: r.signedAt,
        completedAt: r.request.completedAt,
      })),
    });
  }

  /** Requests still waiting for this person's signature. */
  portalPendingCount(email: string, workspaceId: string): Promise<number> {
    return this.prisma.client.signatureSigner.count({
      where: {
        email: email.toLowerCase(),
        status: { in: ['PENDING', 'VIEWED'] },
        request: { workspaceId, deletedAt: null, status: 'SENT', expiresAt: { gt: new Date() } },
      },
    });
  }

  async portalSession(ref: PortalSignerRef, client: ClientInfo): Promise<PublicSignatureSession> {
    return this.sessionFor(await this.resolvePortalSigner(ref), client, 'portal', ref.userId);
  }

  async portalSourceFile(ref: PortalSignerRef) {
    return this.sourceFileFor(await this.resolvePortalSigner(ref));
  }

  async portalSignedFile(ref: PortalSignerRef) {
    return this.signedFileFor(await this.resolvePortalSigner(ref));
  }

  async portalSign(
    ref: PortalSignerRef,
    input: SignPublicInput,
    client: ClientInfo,
  ): Promise<SignPublicResponse> {
    // Per person rather than per IP: a client's office may share one address.
    await this.limitWrites(`esign:rate:user:${ref.userId}`);
    return this.signFor(await this.resolvePortalSigner(ref), input, client, 'portal', ref.userId);
  }

  async portalDecline(
    ref: PortalSignerRef,
    input: DeclinePublicInput,
    client: ClientInfo,
  ): Promise<{ ok: true }> {
    await this.limitWrites(`esign:rate:user:${ref.userId}`);
    return this.declineFor(
      await this.resolvePortalSigner(ref),
      input,
      client,
      'portal',
      ref.userId,
    );
  }

  // ---- Shared implementation ----------------------------------------------

  private async sessionFor(
    { signer, request }: SignerContext,
    client: ClientInfo,
    via: SignerVia,
    userId?: string,
  ): Promise<PublicSignatureSession> {
    if (request.status === 'SENT' && signer.status === 'PENDING') {
      const now = new Date();
      const flipped = await this.prisma.client.signatureSigner.updateMany({
        where: { id: signer.id, status: 'PENDING' },
        data: { status: 'VIEWED', viewedAt: now },
      });
      if (flipped.count === 1) {
        signer.status = 'VIEWED';
        signer.viewedAt = now;
        await this.prisma.client.signatureEvent.create({
          data: {
            requestId: request.id,
            signerId: signer.id,
            kind: 'VIEWED',
            ip: client.ip,
            userAgent: truncate(client.userAgent, 500),
            metadata: viaTrail(via, userId),
          },
        });
      }
    }
    const own = request.fields.filter((f) => f.signerId === signer.id);
    return publicSignatureSessionSchema.parse({
      title: request.title,
      message: request.message,
      workspaceName: request.workspace.name,
      requesterName: request.createdBy.name,
      expiresAt: request.expiresAt,
      requestStatus: request.status,
      pageCount: request.pageCount,
      signer: {
        email: signer.email,
        name: signer.name,
        status: signer.status,
        signedAt: signer.signedAt,
      },
      fields: own.map((f) => ({
        id: f.id,
        kind: f.kind,
        page: f.page,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
      })),
      canPlaceFields: !own.some((f) => f.kind === 'SIGNATURE') && signer.status !== 'SIGNED',
      signersTotal: request.signers.length,
      signersSigned: request.signers.filter((s) => s.status === 'SIGNED').length,
    });
  }

  private async sourceFileFor({ request }: SignerContext) {
    return this.readFile(
      request.workspaceId,
      request.sourceFileId,
      `${safeFilename(request.title)}.pdf`,
    );
  }

  private async signedFileFor({ request }: SignerContext) {
    if (request.status !== 'COMPLETED' || !request.signedFileId) {
      throw new NotFoundException({ title: 'Not signed yet', status: 404 });
    }
    return this.readFile(
      request.workspaceId,
      request.signedFileId,
      `${safeFilename(request.title)} (signed).pdf`,
    );
  }

  private async signFor(
    { signer, request }: SignerContext,
    input: SignPublicInput,
    client: ClientInfo,
    via: SignerVia,
    userId?: string,
  ): Promise<SignPublicResponse> {
    this.assertOpen(request);
    if (signer.status === 'SIGNED' || signer.status === 'DECLINED') {
      throw new ConflictException({
        title: 'Already answered',
        status: 409,
        detail:
          signer.status === 'SIGNED' ? 'You have already signed.' : 'You declined this request.',
      });
    }

    const png = decodeSignaturePng(input.imageDataUrl);
    const own = request.fields.filter((f) => f.signerId === signer.id);
    let placed: SignPublicInput['fields'] = [];
    if (!own.some((f) => f.kind === 'SIGNATURE')) {
      // The requester gave this signer no signature box (maybe only a date),
      // so the signer placed their own. Requester-placed fields are kept.
      placed = (input.fields ?? []).filter((f) => f.page <= request.pageCount);
      if (!placed.some((f) => f.kind === 'SIGNATURE')) {
        throw new BadRequestException({
          title: 'Place your signature',
          status: 400,
          detail: 'Put your signature somewhere on the document before finishing.',
        });
      }
    }

    const stored = await this.files.putBuffer({
      workspaceId: request.workspaceId,
      // FileObject needs an uploader; the requester owns the request's files.
      uploadedById: request.createdById,
      filename: 'signature.png',
      mimeType: 'image/png',
      body: png,
      kind: 'IMAGE',
    });

    const now = new Date();
    await this.prisma.client
      .$transaction(async (tx) => {
        await lockOpenRequest(tx, request.id);
        const flipped = await tx.signatureSigner.updateMany({
          where: { id: signer.id, status: { in: ['PENDING', 'VIEWED'] } },
          data: {
            status: 'SIGNED',
            signedAt: now,
            viewedAt: signer.viewedAt ?? now,
            consentAt: now,
            method: input.method,
            typedName: input.method === 'TYPED' ? (input.typedName ?? null) : null,
            ...(input.signerName ? { name: input.signerName } : {}),
            signatureFileId: stored.id,
            ip: client.ip,
            userAgent: truncate(client.userAgent, 500),
          },
        });
        if (flipped.count !== 1) {
          throw new ConflictException({ title: 'Already answered', status: 409 });
        }
        if (placed && placed.length > 0) {
          await tx.signatureField.createMany({
            data: placed.map((f) => ({
              requestId: request.id,
              signerId: signer.id,
              kind: f.kind,
              page: f.page,
              x: f.x,
              y: f.y,
              w: Math.min(f.w, 1 - f.x),
              h: Math.min(f.h, 1 - f.y),
              placedBySigner: true,
            })),
          });
        }
        await tx.signatureEvent.create({
          data: {
            requestId: request.id,
            signerId: signer.id,
            kind: 'SIGNED',
            ip: client.ip,
            userAgent: truncate(client.userAgent, 500),
            metadata: { method: input.method, consent: true, ...viaTrail(via, userId) },
          },
        });
      })
      .catch(async (err: unknown) => {
        // Another request signed first, or the write failed: drop the image
        // this call stored so no orphan signature is left in the workspace.
        await this.prisma.client.fileObject
          .delete({ where: { id: stored.id } })
          .catch(() => undefined);
        throw err;
      });

    const remaining = await this.prisma.client.signatureSigner.count({
      where: { requestId: request.id, status: { not: 'SIGNED' } },
    });
    const allSigned = remaining === 0;
    const who = input.signerName || signer.name || signer.email;

    void this.notifications
      .emit({
        userId: request.createdById,
        type: 'SIGNATURE_SIGNED',
        title: allSigned
          ? `Everyone signed "${request.title}"`
          : `${who} signed "${request.title}"`,
        body: allSigned
          ? 'The signed PDF is being prepared.'
          : `${request.signers.length - remaining} of ${request.signers.length} signed.`,
        entityType: 'signature',
        entityId: request.id,
        url: requestUrl(request.documentId),
      })
      .catch((err: unknown) =>
        this.logger.warn(`Notify failed: ${(err as Error)?.message ?? err}`),
      );

    if (allSigned) await this.enqueueSeal(request.id, false);
    return signPublicResponseSchema.parse({ status: 'SIGNED', allSigned });
  }

  private async declineFor(
    { signer, request }: SignerContext,
    input: DeclinePublicInput,
    client: ClientInfo,
    via: SignerVia,
    userId?: string,
  ): Promise<{ ok: true }> {
    this.assertOpen(request);
    if (signer.status === 'SIGNED' || signer.status === 'DECLINED') {
      throw new ConflictException({ title: 'Already answered', status: 409 });
    }
    const now = new Date();
    await this.prisma.client.$transaction(async (tx) => {
      await lockOpenRequest(tx, request.id);
      const flipped = await tx.signatureSigner.updateMany({
        where: { id: signer.id, status: { in: ['PENDING', 'VIEWED'] } },
        data: {
          status: 'DECLINED',
          declinedAt: now,
          declineReason: input.reason,
          // Nothing is left to do through this link (the request is closed
          // and no signed file will exist), so retire it.
          tokenHash: unusableTokenHash(),
          codeHash: null,
          ip: client.ip,
          userAgent: truncate(client.userAgent, 500),
        },
      });
      if (flipped.count !== 1)
        throw new ConflictException({ title: 'Already answered', status: 409 });
      const closed = await tx.signatureRequest.updateMany({
        where: { id: request.id, status: 'SENT' },
        data: { status: 'DECLINED' },
      });
      if (closed.count !== 1) throw requestClosedConflict();
      await tx.signatureEvent.create({
        data: {
          requestId: request.id,
          signerId: signer.id,
          kind: 'DECLINED',
          ip: client.ip,
          userAgent: truncate(client.userAgent, 500),
          metadata: { reason: input.reason, ...viaTrail(via, userId) },
        },
      });
    });

    void this.notifications
      .emit({
        userId: request.createdById,
        type: 'SIGNATURE_DECLINED',
        title: `${signer.email} declined to sign "${request.title}"`,
        body: input.reason.slice(0, 200),
        entityType: 'signature',
        entityId: request.id,
        url: requestUrl(request.documentId),
      })
      .catch((err: unknown) =>
        this.logger.warn(`Notify failed: ${(err as Error)?.message ?? err}`),
      );
    await this.email.sendSignatureDeclined(request.workspace.organizationId, {
      to: request.createdBy.email,
      title: request.title,
      signerEmail: signer.email,
      reason: input.reason,
      url: absoluteAppUrl(requestUrl(request.documentId)),
    });
    return { ok: true };
  }

  // =========================================================================
  // Sealing (called by the queue worker)
  // =========================================================================

  async seal(requestId: string): Promise<void> {
    const row = await this.prisma.client.signatureRequest.findFirst({
      where: { id: requestId },
      include: {
        ...DETAILS_INCLUDE,
        workspace: { select: { name: true, organizationId: true } },
      },
    });
    if (!row) {
      this.logger.warn(`Seal skipped: request ${requestId} not found`);
      return;
    }
    if (row.signedFileId || row.status === 'COMPLETED') return; // idempotent
    if (row.status !== 'SENT' || row.signers.some((s) => s.status !== 'SIGNED')) {
      this.logger.warn(`Seal skipped: request ${requestId} is ${row.status} or not fully signed`);
      return;
    }

    const source = await this.files.getObjectBuffer(row.workspaceId, row.sourceFileId, {
      includeDeleted: true,
    });
    if (!source) throw new Error(`Source PDF ${row.sourceFileId} missing`);
    if (sha256Hex(source.body) !== row.sourceSha256) {
      // The stored object no longer matches what the signers saw. Refuse to
      // seal rather than stamp signatures onto a different document.
      throw new Error(`Source PDF for ${requestId} does not match its recorded SHA-256`);
    }

    const signatureImages = await Promise.all(
      row.signers.map(async (s) =>
        s.signatureFileId
          ? ((
              await this.files.getObjectBuffer(row.workspaceId, s.signatureFileId, {
                includeDeleted: true,
              })
            )?.body ?? null)
          : null,
      ),
    );
    const indexById = new Map(row.signers.map((s, i) => [s.id, i]));
    const completedAt = new Date();
    const bytes = await this.pdf.seal({
      source: source.body,
      requestId: row.id,
      title: row.title,
      workspaceName: row.workspace.name,
      requesterName: row.createdBy.name,
      requesterEmail: row.createdBy.email,
      sentAt: row.sentAt,
      completedAt,
      sourceSha256: row.sourceSha256,
      signers: row.signers.map((s, i) => ({
        email: s.email,
        name: s.name,
        status: s.status,
        method: s.method,
        typedName: s.typedName,
        viewedAt: s.viewedAt,
        signedAt: s.signedAt,
        consentAt: s.consentAt,
        ip: s.ip,
        userAgent: s.userAgent,
        signaturePng: signatureImages[i] ?? null,
      })),
      fields: row.fields
        .filter((f) => indexById.has(f.signerId))
        .map((f) => ({
          signerIndex: indexById.get(f.signerId)!,
          kind: f.kind,
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
        })),
    });
    const body = Buffer.from(bytes);
    const signedSha256 = sha256Hex(body);
    const filename = `${safeFilename(row.title)} (signed).pdf`;
    const stored = await this.files.putBuffer({
      workspaceId: row.workspaceId,
      uploadedById: row.createdById,
      filename,
      mimeType: 'application/pdf',
      body,
      kind: 'PDF',
    });

    const done = await this.prisma.client.$transaction(async (tx) => {
      await tx.fileObject.update({ where: { id: stored.id }, data: { checksum: signedSha256 } });
      const flipped = await tx.signatureRequest.updateMany({
        where: { id: row.id, signedFileId: null, status: 'SENT' },
        data: { status: 'COMPLETED', signedFileId: stored.id, signedSha256, completedAt },
      });
      if (flipped.count !== 1) return false;
      await tx.signatureEvent.create({
        data: { requestId: row.id, kind: 'COMPLETED', metadata: { signedSha256 } },
      });
      return true;
    });
    if (!done) {
      // A concurrent run finished first; drop our duplicate object row.
      await this.prisma.client.fileObject
        .delete({ where: { id: stored.id } })
        .catch(() => undefined);
      return;
    }

    void this.notifications
      .emit({
        userId: row.createdById,
        type: 'SIGNATURE_COMPLETED',
        title: `"${row.title}" is signed`,
        body: 'Everyone has signed. The signed PDF is ready to download.',
        entityType: 'signature',
        entityId: row.id,
        url: requestUrl(row.documentId),
      })
      .catch((err: unknown) =>
        this.logger.warn(`Notify failed: ${(err as Error)?.message ?? err}`),
      );

    const recipients = [...new Set([row.createdBy.email, ...row.signers.map((s) => s.email)])];
    await this.email.sendSignatureCompleted(row.workspace.organizationId, recipients, {
      title: row.title,
      workspaceName: row.workspace.name,
      signedSha256,
      workspaceId: row.workspaceId,
      pdfFileId: stored.id,
      filename,
    });
    this.logger.log(`Sealed signature request ${row.id}`);
  }

  /** Called by the worker once a seal job has used every retry. */
  async recordSealFailure(requestId: string, message: string): Promise<void> {
    await this.prisma.client.signatureEvent
      .create({
        data: { requestId, kind: 'SEAL_FAILED', metadata: { message: message.slice(0, 500) } },
      })
      .catch(() => undefined);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private docCtx(actor: SignatureActor) {
    return { userId: actor.userId, workspaceRole: actor.workspaceRole };
  }

  private async loadDetails(id: string): Promise<RequestWithDetails> {
    const row = await this.prisma.client.signatureRequest.findFirst({
      where: { id },
      include: DETAILS_INCLUDE,
    });
    if (!row) throw new NotFoundException({ title: 'Signature request not found', status: 404 });
    return row;
  }

  /** Creator, workspace admin, or anyone who can read the source document. */
  private async loadForView(actor: SignatureActor, id: string): Promise<RequestWithDetails> {
    const row = await this.prisma.client.signatureRequest.findFirst({
      where: { AND: [{ id }, signatureVisibleWhere(actor)] },
      include: DETAILS_INCLUDE,
    });
    if (!row) throw new NotFoundException({ title: 'Signature request not found', status: 404 });
    return row;
  }

  /**
   * A client's Signatures tab: requests this viewer may see whose source
   * document is filed under the client or in one of its projects, or that
   * someone at the client was asked to sign. Newest first, keyset-paged.
   */
  async listForClient(
    actor: SignatureActor,
    clientViewer: SalesActor,
    clientId: string,
    query: ClientHubPageQuery,
  ): Promise<ClientSignatureList> {
    const client = await requireVisibleClient(clientViewer, clientId, (where) =>
      this.prisma.client.client.findFirst({
        where,
        select: {
          id: true,
          // Nested relation reads skip the soft-delete filter, so revoked portal
          // people are included: what they were asked to sign stays on record.
          contacts: { select: { user: { select: { email: true } } } },
        },
      }),
    );
    const contactEmails = client.contacts.map((c) => c.user.email);
    const page = { cursor: decodeCursor(query.cursor), limit: query.limit };
    const rows = await this.prisma.client.signatureRequest.findMany({
      where: {
        AND: [
          signatureVisibleWhere(actor),
          clientSignatureRelationWhere(client.id, contactEmails),
          keysetWhere(CLIENT_SIGNATURE_SOURCE, 'createdAt', page.cursor),
        ],
      },
      include: {
        ...SUMMARY_INCLUDE,
        document: { select: { id: true, title: true, deletedAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return clientSignatureListSchema.parse({
      items: items.map((r) => ({
        ...baseRequest(r),
        status: effectiveStatus(r.status, r.expiresAt, r.signers),
        createdBy: r.createdBy,
        signers: r.signers,
        document:
          r.document && r.document.deletedAt === null
            ? { id: r.document.id, title: r.document.title }
            : null,
      })),
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ at: last.createdAt, source: CLIENT_SIGNATURE_SOURCE, rowId: last.id })
          : null,
    });
  }

  /** Only the creator or a workspace admin changes a request. */
  private async loadForManage(actor: SignatureActor, id: string): Promise<RequestWithDetails> {
    const row = await this.loadForView(actor, id);
    if (row.createdById !== actor.userId && !isWorkspaceAdmin(actor)) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only the person who sent this request, or a workspace admin, can change it.',
      });
    }
    return row;
  }

  /**
   * Link token + code. The token selects exactly one signer; the code is then
   * checked against that signer only. Wrong codes count towards a lockout
   * that only a resend (new link, new code) lifts. Signers without a code
   * hash (links emailed before codes existed, including the old guessable
   * 6-digit links) are refused and need a resend.
   *
   * After SIGNED the link keeps working (with the code) so the signer can
   * download the sealed PDF once it is ready; sign and decline are refused
   * by the status checks in signFor / declineFor.
   */
  private async resolveToken(token: string, code: string | undefined): Promise<SignerContext> {
    const signer = await this.prisma.client.signatureSigner.findUnique({
      where: { tokenHash: hashSigningToken(token) },
    });
    if (!signer || !signer.codeHash) throw notFoundLink();
    if (signer.codeLockedAt || attemptsExhausted(signer.codeAttempts)) throw codeLocked();
    if (!code) {
      throw new HttpException(
        {
          title: 'Code required',
          status: 401,
          detail: 'Enter the 6-digit code from the email that brought you here.',
          code: 'signing-code-required',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!accessCodeMatches(code, signer.codeHash)) {
      // Atomic increment, then lock once the limit is reached. Concurrent
      // guesses each count, so parallel requests cannot exceed the budget.
      const bumped = await this.prisma.client.signatureSigner.update({
        where: { id: signer.id },
        data: { codeAttempts: { increment: 1 } },
        select: { codeAttempts: true },
      });
      if (attemptsExhausted(bumped.codeAttempts)) {
        await this.prisma.client.signatureSigner.updateMany({
          where: { id: signer.id, codeLockedAt: null },
          data: { codeLockedAt: new Date() },
        });
        throw codeLocked();
      }
      const left = MAX_ACCESS_CODE_ATTEMPTS - bumped.codeAttempts;
      throw new HttpException(
        {
          title: 'Wrong code',
          status: 401,
          detail: `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
          code: 'signing-code-invalid',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (signer.codeAttempts > 0) {
      await this.prisma.client.signatureSigner.updateMany({
        where: { id: signer.id, codeLockedAt: null },
        data: { codeAttempts: 0 },
      });
    }
    return this.loadSignerContext(signer);
  }

  private async resolvePortalSigner(ref: PortalSignerRef): Promise<SignerContext> {
    const signer = await this.prisma.client.signatureSigner.findFirst({
      where: {
        id: ref.signerId,
        email: ref.email.toLowerCase(),
        request: { workspaceId: ref.workspaceId, deletedAt: null },
      },
    });
    if (!signer) {
      throw new NotFoundException({ title: 'Signature request not found', status: 404 });
    }
    return this.loadSignerContext(signer);
  }

  /** Shared status and expiry rules for both ways a signer arrives. */
  private async loadSignerContext(signer: SignerRow): Promise<SignerContext> {
    const request = await this.prisma.client.signatureRequest.findFirst({
      where: { id: signer.requestId },
      include: SIGNER_REQUEST_INCLUDE,
    });
    if (!request || request.status === 'DRAFT' || request.status === 'CANCELLED') {
      throw notFoundLink();
    }
    const allSigned = request.signers.every((s) => s.status === 'SIGNED');
    if (request.status === 'SENT' && !allSigned && request.expiresAt.getTime() <= Date.now()) {
      await this.prisma.client.signatureRequest.updateMany({
        where: { id: request.id, status: 'SENT' },
        data: { status: 'EXPIRED' },
      });
      request.status = 'EXPIRED';
    }
    if (request.status === 'EXPIRED') {
      throw new GoneException({
        title: 'This signing link has expired',
        status: 410,
        detail: `Ask ${request.createdBy.name || 'the sender'} to send it again.`,
        code: 'signing-link-expired',
      });
    }
    return { signer, request };
  }

  private assertOpen(request: { status: string; expiresAt: Date }): void {
    if (request.status !== 'SENT') {
      throw new ConflictException({
        title: 'This request is closed',
        status: 409,
        detail:
          request.status === 'COMPLETED'
            ? 'Everyone has already signed.'
            : 'Another signer declined, so this request is closed.',
      });
    }
  }

  /** Sign and decline cap: per IP for links, per person in the portal. */
  private async limitWrites(key: string): Promise<void> {
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, 3600);
    if (count > MAX_PUBLIC_WRITES_PER_HOUR) {
      throw new HttpException(
        { title: 'Too many attempts', status: 429, detail: 'Please try again in an hour.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async readFile(workspaceId: string, fileId: string, filename: string) {
    const obj = await this.files.getObjectBuffer(workspaceId, fileId, { includeDeleted: true });
    if (!obj) throw new NotFoundException({ title: 'File not found', status: 404 });
    return { body: obj.body, filename };
  }

  private async emailSigners(
    row: RequestWithDetails,
    tokens: Array<{ signerId: string; raw: string; code: string }>,
  ): Promise<boolean> {
    const workspace = await this.prisma.client.workspace.findFirst({
      where: { id: row.workspaceId },
      select: { name: true, organizationId: true },
    });
    const expiresAtLabel = row.expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const jobs = tokens.flatMap(({ signerId, raw, code }) => {
      const signer = row.signers.find((s) => s.id === signerId);
      if (!signer) return [];
      return [
        {
          to: signer.email,
          signerName: signer.name,
          requesterName: row.createdBy.name,
          workspaceName: workspace?.name ?? 'The Botss',
          title: row.title,
          message: row.message,
          url: signingUrl(raw),
          code,
          expiresAtLabel,
          replyTo: row.createdBy.email,
        },
      ];
    });
    return this.email.sendSignatureRequests(workspace?.organizationId, jobs);
  }

  private async enqueueSeal(requestId: string, retry: boolean): Promise<void> {
    const jobId = sealJobId(requestId);
    if (retry) {
      // A finished (failed) job with the same id would swallow the new one.
      const existing = await this.queue.getJob(jobId);
      if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) {
        await existing.remove();
      }
    }
    await this.queue.add('seal', { requestId }, { ...SEAL_JOB_OPTIONS, jobId });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWorkspaceAdmin(actor: SignatureActor): boolean {
  return actor.workspaceRole === 'OWNER' || actor.workspaceRole === 'ADMIN';
}

/**
 * A SENT request past its expiry, with someone still to sign, is EXPIRED for
 * display even before the lazy flip in resolveToken has written it.
 */
function effectiveStatus(
  status: string,
  expiresAt: Date,
  signers: Array<{ status: string }>,
): string {
  if (status !== 'SENT' || expiresAt.getTime() > Date.now()) return status;
  return signers.every((s) => s.status === 'SIGNED') ? status : 'EXPIRED';
}

function baseRequest(r: {
  id: string;
  workspaceId: string;
  createdById: string;
  documentId: string | null;
  title: string;
  message: string | null;
  status: string;
  expiresAt: Date;
  sourceSha256: string;
  signedSha256: string | null;
  signedFileId: string | null;
  pageCount: number;
  sentAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    createdById: r.createdById,
    documentId: r.documentId,
    title: r.title,
    message: r.message,
    status: r.status,
    expiresAt: r.expiresAt,
    sourceSha256: r.sourceSha256,
    signedSha256: r.signedSha256,
    pageCount: r.pageCount,
    hasSignedFile: Boolean(r.signedFileId),
    sentAt: r.sentAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toDetails(r: RequestWithDetails): SignatureRequestDetails {
  return signatureRequestDetailsSchema.parse({
    ...baseRequest(r),
    status: effectiveStatus(r.status, r.expiresAt, r.signers),
    createdBy: r.createdBy,
    signers: r.signers,
    fields: r.fields,
    events: r.events,
  });
}

/**
 * Lock the request row for the rest of the transaction, and fail unless it is
 * still open. Every writer of a request's status (sign, decline, cancel, seal)
 * then serialises on this row: a cancel that lands while a signature is being
 * written waits for it, and a signature that lands after a cancel fails.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: it conflicts with the other writers'
 * row updates, but not with the FOR KEY SHARE that foreign-key checks take
 * when a signature event or field is inserted. FOR UPDATE would deadlock a
 * resend (signer row, then event insert) against a sign (request row, then
 * signer row) for the same signer.
 */
async function lockOpenRequest(
  tx: { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  requestId: string,
  onClosed: () => ConflictException = requestClosedConflict,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "SignatureRequest"
    WHERE id = ${requestId} AND status = 'SENT' AND "deletedAt" IS NULL
    FOR NO KEY UPDATE`;
  if (rows.length !== 1) throw onClosed();
}

function requestClosedConflict(): ConflictException {
  return new ConflictException({
    title: 'This request is closed',
    status: 409,
    detail:
      'It was cancelled or changed while you were signing. Reload the page to see its current state.',
  });
}

/** Columns that (re)arm a signer's link: new token and code, no strikes. */
function freshLinkData(tokenHash: string, codeHash: string) {
  return { tokenHash, codeHash, codeAttempts: 0, codeLockedAt: null };
}

function codeLocked(): HttpException {
  return new HttpException(
    {
      title: 'Link locked',
      status: 423,
      detail: 'Too many wrong codes were entered for this link. Ask the sender to send it again.',
      code: 'signing-code-locked',
    },
    423, // Locked (HttpStatus has no LOCKED member in Nest 10)
  );
}

function notFoundLink(): NotFoundException {
  return new NotFoundException({
    title: 'Signing link not found',
    status: 404,
    detail:
      'This link is not valid any more. It may have been replaced by a newer email, or the request was cancelled.',
    code: 'signing-link-invalid',
  });
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function safeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'document').slice(0, 120);
}

function requestUrl(documentId: string | null): string {
  return documentId ? `/documents?doc=${encodeURIComponent(documentId)}` : '/documents';
}

function absoluteAppUrl(path: string): string {
  const base = (process.env.PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}
