import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { isSafeInlineImage, SIGNATURE_CONSENT_TEXT } from '@botss/shared-types';
import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';

import { FilesService } from '../files/files.service';
import { GotenbergClient } from '../pdf/gotenberg.client';
import { PrismaService } from '../prisma/prisma.service';
import { collectImageSources, printDocument, tiptapToPrintHtml } from './document-html';
import { fieldRect, fitInside, placement, type Box } from './geometry';

/** Uploaded PDFs above this are refused: signing loads the whole file in the
 *  browser and pdf-lib holds it in memory while sealing. */
export const MAX_SOURCE_PDF_BYTES = 25 * 1024 * 1024;
/** Total bytes of images inlined into a rendered document. */
const MAX_INLINED_IMAGE_BYTES = 20 * 1024 * 1024;

export interface SealSigner {
  email: string;
  name: string | null;
  status: string;
  method: string | null;
  typedName: string | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  consentAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  signaturePng: Buffer | null;
}

export interface SealField {
  signerIndex: number;
  kind: 'SIGNATURE' | 'DATE';
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

@Injectable()
export class SignaturePdfService {
  private readonly logger = new Logger(SignaturePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly gotenberg: GotenbergClient,
  ) {}

  /** Render a Botss document to an A4 PDF, images inlined. */
  async renderDocument(workspaceId: string, documentId: string): Promise<Buffer> {
    const doc = await this.prisma.client.document.findFirst({
      where: { id: documentId, workspaceId },
      select: {
        title: true,
        content: true,
        updatedAt: true,
        createdBy: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });
    if (!doc) {
      throw new UnprocessableEntityException({
        title: 'Document not found',
        status: 422,
        detail: 'The document to sign no longer exists.',
      });
    }
    const images = await this.inlineImages(workspaceId, collectImageSources(doc.content));
    const html = printDocument({
      title: doc.title,
      workspaceName: doc.workspace.name,
      authorName: doc.createdBy.name,
      updatedAt: doc.updatedAt,
      bodyHtml: tiptapToPrintHtml(doc.content, images),
    });
    return this.gotenberg.htmlToPdf(html, {
      paper: 'A4',
      marginsMm: { top: 20, right: 18, bottom: 20, left: 18 },
    });
  }

  /**
   * Gotenberg has no network, so document images become data URIs. Only
   * images stored in this workspace's bucket are embedded (looked up by their
   * stored URL); anything else renders as a placeholder.
   */
  private async inlineImages(workspaceId: string, srcs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (srcs.length === 0) return out;
    const rows = await this.prisma.client.fileObject.findMany({
      where: { workspaceId, url: { in: srcs } },
      select: { id: true, url: true, mimeType: true },
    });
    let total = 0;
    for (const row of rows) {
      if (!row.url || !isSafeInlineImage(row.mimeType)) continue;
      const obj = await this.files.getObjectBuffer(workspaceId, row.id).catch(() => null);
      if (!obj) continue;
      total += obj.body.byteLength;
      if (total > MAX_INLINED_IMAGE_BYTES) {
        throw new UnprocessableEntityException({
          title: 'Document images are too large',
          status: 422,
          detail:
            'The images in this document add up to more than 20 MB. Shrink them and try again.',
        });
      }
      out.set(row.url, `data:${row.mimeType};base64,${obj.body.toString('base64')}`);
    }
    return out;
  }

  /** Page count, and a clear error for PDFs we cannot stamp. */
  async inspect(bytes: Uint8Array): Promise<{ pageCount: number }> {
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      const encrypted = /encrypt/i.test((err as Error)?.message ?? '');
      throw new UnprocessableEntityException({
        title: encrypted ? 'Password-protected PDF' : 'Unreadable PDF',
        status: 422,
        detail: encrypted
          ? 'This PDF is encrypted, so signatures cannot be added to it. Upload an unprotected copy.'
          : 'This file could not be read as a PDF.',
        code: encrypted ? 'pdf-encrypted' : 'pdf-unreadable',
      });
    }
    const pageCount = pdf.getPageCount();
    if (pageCount < 1) {
      throw new UnprocessableEntityException({
        title: 'Empty PDF',
        status: 422,
        detail: 'The PDF has no pages.',
      });
    }
    return { pageCount };
  }

  /**
   * Stamp every field and append the certificate page. Deterministic for the
   * same inputs, so a retried seal produces the same document.
   */
  async seal(args: {
    source: Uint8Array;
    requestId: string;
    title: string;
    workspaceName: string;
    requesterName: string;
    requesterEmail: string;
    sentAt: Date | null;
    completedAt: Date;
    sourceSha256: string;
    signers: SealSigner[];
    fields: SealField[];
  }): Promise<Uint8Array> {
    const pdf = await PDFDocument.load(args.source, { updateMetadata: false });
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    // One embedded image per signer, reused across that signer's fields.
    const images = await Promise.all(
      args.signers.map((s) =>
        s.signaturePng ? pdf.embedPng(s.signaturePng) : Promise.resolve(null),
      ),
    );

    const pages = pdf.getPages();
    for (const field of args.fields) {
      const page = pages[field.page - 1];
      const signer = args.signers[field.signerIndex];
      if (!page || !signer) continue;
      const crop = page.getCropBox();
      const box: Box = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
      const rotation = page.getRotation().angle;
      const rect = fieldRect(box, rotation, field);

      if (field.kind === 'SIGNATURE') {
        const img = images[field.signerIndex];
        if (!img) continue;
        const fit = fitInside(img.width, img.height, rect.width, rect.height);
        const drawRect = {
          x: rect.x + fit.x,
          y: rect.y + fit.y,
          width: fit.width,
          height: fit.height,
        };
        const at = placement(box, rotation, drawRect);
        page.drawImage(img, {
          x: at.x,
          y: at.y,
          width: drawRect.width,
          height: drawRect.height,
          rotate: degrees(at.rotate),
        });
      } else {
        const text = formatDay(signer.signedAt ?? args.completedAt);
        const size = Math.max(6, Math.min(11, rect.height * 0.62));
        const width = helvetica.widthOfTextAtSize(text, size);
        // Baseline a little above the bottom of the box; left-aligned.
        const textRect = {
          x: rect.x + 2,
          y: rect.y + (rect.height - size) / 2,
          width,
          height: size,
        };
        const at = placement(box, rotation, textRect);
        page.drawText(text, {
          x: at.x,
          y: at.y,
          size,
          font: helvetica,
          color: rgb(0.06, 0.09, 0.16),
          rotate: degrees(at.rotate),
        });
      }
    }

    this.appendCertificate(pdf, helvetica, bold, args);

    pdf.setProducer('The Botss e-signature');
    pdf.setModificationDate(args.completedAt);
    return pdf.save();
  }

  private appendCertificate(
    pdf: PDFDocument,
    font: PDFFont,
    bold: PDFFont,
    args: {
      requestId: string;
      title: string;
      workspaceName: string;
      requesterName: string;
      requesterEmail: string;
      sentAt: Date | null;
      completedAt: Date;
      sourceSha256: string;
      signers: SealSigner[];
    },
  ): void {
    const W = 595.28;
    const H = 841.89;
    const M = 48;
    const ink = rgb(0.06, 0.09, 0.16);
    const muted = rgb(0.39, 0.45, 0.55);
    const line = rgb(0.89, 0.91, 0.94);

    let page: PDFPage = pdf.addPage([W, H]);
    let y = H - M;

    const safe = (text: string, f: PDFFont) => pdfSafeText(text, f);
    const newPageIfNeeded = (needed: number) => {
      if (y - needed >= M + 24) return;
      page = pdf.addPage([W, H]);
      y = H - M;
    };
    const write = (
      text: string,
      opts: {
        size?: number;
        f?: PDFFont;
        color?: ReturnType<typeof rgb>;
        indent?: number;
        gap?: number;
      } = {},
    ) => {
      const size = opts.size ?? 9.5;
      const f = opts.f ?? font;
      const indent = opts.indent ?? 0;
      const maxWidth = W - 2 * M - indent;
      for (const ln of wrap(safe(text, f), f, size, maxWidth)) {
        newPageIfNeeded(size + 4);
        page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color: opts.color ?? ink });
        y -= size + 3.5;
      }
      y -= opts.gap ?? 0;
    };
    const row = (label: string, value: string) => {
      newPageIfNeeded(14);
      const size = 9.5;
      page.drawText(safe(label, font), { x: M, y: y - size, size, font, color: muted });
      const lines = wrap(safe(value, font), font, size, W - 2 * M - 120);
      lines.forEach((ln, i) => {
        if (i > 0) newPageIfNeeded(size + 4);
        page.drawText(ln, { x: M + 120, y: y - size, size, font, color: ink });
        y -= size + 3.5;
      });
      if (lines.length === 0) y -= size + 3.5;
    };
    const rule = () => {
      newPageIfNeeded(12);
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: line });
      y -= 10;
    };

    write('Signature certificate', { size: 18, f: bold, gap: 4 });
    write('This page records how and when each person signed the document above.', {
      size: 9.5,
      color: muted,
      gap: 8,
    });
    rule();
    row('Document', args.title);
    row('Request ID', args.requestId);
    row('Workspace', args.workspaceName);
    row('Sent by', `${args.requesterName} <${args.requesterEmail}>`);
    row('Sent', args.sentAt ? formatInstant(args.sentAt) : 'n/a');
    row('Completed', formatInstant(args.completedAt));
    row('Original SHA-256', args.sourceSha256);
    rule();

    args.signers.forEach((s, i) => {
      newPageIfNeeded(120);
      write(`Signer ${i + 1}: ${s.name?.trim() || s.email}`, { size: 11, f: bold, gap: 2 });
      row('Email', s.email);
      row('Status', s.status.toLowerCase());
      row('Viewed', s.viewedAt ? formatInstant(s.viewedAt) : 'n/a');
      row('Signed', s.signedAt ? formatInstant(s.signedAt) : 'n/a');
      row(
        'Method',
        s.method === 'TYPED'
          ? `Typed name${s.typedName ? `: ${s.typedName}` : ''}`
          : s.method === 'DRAWN'
            ? 'Drawn signature'
            : 'n/a',
      );
      row('Consent', s.consentAt ? `Agreed ${formatInstant(s.consentAt)}` : 'n/a');
      row('IP address', s.ip ?? 'n/a');
      row('Device', s.userAgent ?? 'n/a');
      y -= 6;
    });
    rule();
    write(`Consent wording: "${SIGNATURE_CONSENT_TEXT}"`, { size: 8.5, color: muted, gap: 4 });
    write(
      'Integrity: the SHA-256 fingerprint of this final file is recorded in The Botss and in the completion email. Any change to the file changes its fingerprint.',
      { size: 8.5, color: muted },
    );
  }
}

function formatInstant(d: Date): string {
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function formatDay(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The standard PDF fonts only cover WinAnsi. Strip accents where that makes a
 * character encodable (Turkish ş/ğ/ı, etc.) and replace anything else with
 * "?", so a name in another script never fails the seal. The signature image
 * itself is untouched; this only affects the certificate text.
 */
function pdfSafeText(text: string, font: PDFFont): string {
  const cleaned = text
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\r\n\t]+/g, ' ');
  let out = '';
  for (const ch of cleaned) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

/** Greedy word wrap; very long tokens (hashes, user agents) break by width. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (fits(word)) {
      current = word;
      continue;
    }
    // Hard-break a token wider than the line.
    let chunk = '';
    for (const ch of word) {
      if (fits(chunk + ch)) chunk += ch;
      else {
        lines.push(chunk);
        chunk = ch;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines;
}
