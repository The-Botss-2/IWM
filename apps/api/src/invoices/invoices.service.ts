import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import {
  invoiceSettingsSchema,
  type CreateInvoiceInput,
  type CreateLineItemInput,
  type InvoicePdfResponse,
  type InvoicePreviewInput,
  type InvoiceSettings,
  type InvoiceSettingsResponse,
  type InvoiceTemplateList,
  type InvoiceWithItems,
  type ListInvoicesQuery,
  type RecordPaymentInput,
  type SendInvoiceInput,
  type SetInvoiceStatusInput,
  type UpdateInvoiceInput,
} from '@botss/shared-types';
import { Prisma, type InvoiceStatus } from '@botss/database';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';
import { PaymentsService } from '../finance/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { GotenbergClient } from '../pdf/gotenberg.client';
import { InvoiceRenderService } from './invoice-render.service';
import { DEFAULT_TEMPLATE_KEY, InvoiceTemplatesService } from './invoice-templates.service';

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;

@Injectable()
export class InvoicesService {
  private readonly log = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly templates: InvoiceTemplatesService,
    private readonly renderer: InvoiceRenderService,
    private readonly pdf: GotenbergClient,
    private readonly files: FilesService,
    private readonly email: EmailService,
  ) {}

  /** In-flight PDF renders per invoice, so double clicks share one render. */
  private readonly pdfRenders = new Map<string, Promise<InvoicePdfResponse>>();

  // -------------------------------------------------------------------------
  // Access helpers
  // -------------------------------------------------------------------------

  private requireWorkspace(scope: UserScope): string {
    if (!scope.currentWorkspaceId || scope.workspaceIds.length === 0) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Active workspace required.',
      });
    }
    return scope.currentWorkspaceId;
  }

  private async requireInvoice(scope: UserScope, id: string) {
    const workspaceId = this.requireWorkspace(scope);
    const invoice = await this.prisma.client.invoice.findFirst({
      where: { id, workspaceId },
      include: { lineItems: { orderBy: { position: 'asc' } }, payments: true },
    });
    if (!invoice) {
      throw new NotFoundException({
        title: 'Invoice not found',
        status: 404,
      });
    }
    return invoice;
  }

  // -------------------------------------------------------------------------
  // Number sequencing - atomic per (workspace, year)
  // -------------------------------------------------------------------------

  /**
   * Bump and return the next invoice number, atomically. Accepts the extended
   * client variant returned inside `$transaction(async (tx) => ...)` - typed as
   * `unknown`-shape via parameter inference rather than `Prisma.TransactionClient`
   * because the soft-delete extension makes the runtime client a different type
   * than the bare client `tx` would otherwise satisfy.
   */
  private async nextNumber(
    tx: Parameters<Parameters<typeof this.prisma.client.$transaction>[0]>[0],
    workspaceId: string,
    issuedAt: Date,
  ): Promise<string> {
    const year = issuedAt.getUTCFullYear();
    // Upsert in a single statement so concurrent invoice creations don't race.
    // The unique pkey on workspaceId guarantees one row per workspace; we bump
    // lastNumber atomically when the year matches, or reset if the year rolled.
    const existing = await tx.invoiceNumberSequence.findUnique({
      where: { workspaceId },
    });
    let lastNumber: number;
    if (!existing) {
      await tx.invoiceNumberSequence.create({
        data: { workspaceId, year, lastNumber: 1 },
      });
      lastNumber = 1;
    } else if (existing.year !== year) {
      await tx.invoiceNumberSequence.update({
        where: { workspaceId },
        data: { year, lastNumber: 1 },
      });
      lastNumber = 1;
    } else {
      const updated = await tx.invoiceNumberSequence.update({
        where: { workspaceId },
        data: { lastNumber: { increment: 1 } },
      });
      lastNumber = updated.lastNumber;
    }
    return `INV-${year}-${String(lastNumber).padStart(4, '0')}`;
  }

  async peekNextNumber(scope: UserScope, year?: number): Promise<string> {
    const workspaceId = this.requireWorkspace(scope);
    const targetYear = year ?? new Date().getUTCFullYear();
    const seq = await this.prisma.client.invoiceNumberSequence.findUnique({
      where: { workspaceId },
    });
    const next = seq && seq.year === targetYear ? seq.lastNumber + 1 : 1;
    return `INV-${targetYear}-${String(next).padStart(4, '0')}`;
  }

  // -------------------------------------------------------------------------
  // Computation - server is authoritative for line item amounts + invoice totals.
  // -------------------------------------------------------------------------

  private computeLineItem(input: CreateLineItemInput): {
    description: string;
    quantity: Decimal;
    unitPrice: Decimal;
    taxRate: Decimal;
    discountRate: Decimal;
    amount: Decimal;
  } {
    const quantity = new D(input.quantity ?? 1);
    const unitPrice = new D(input.unitPrice ?? 0);
    const taxRate = new D(input.taxRate ?? 0);
    const discountRate = new D(input.discountRate ?? 0);
    const gross = quantity.mul(unitPrice);
    const discount = gross.mul(discountRate).div(100);
    const taxable = gross.sub(discount);
    const tax = taxable.mul(taxRate).div(100);
    const amount = taxable.add(tax);
    return { description: input.description, quantity, unitPrice, taxRate, discountRate, amount };
  }

  private computeTotals(lineItems: { amount: Decimal; quantity: Decimal; unitPrice: Decimal; discountRate: Decimal; taxRate: Decimal }[]) {
    let subtotal = new D(0);
    let discountAmount = new D(0);
    let taxAmount = new D(0);
    let total = new D(0);
    for (const li of lineItems) {
      const gross = li.quantity.mul(li.unitPrice);
      subtotal = subtotal.add(gross);
      const discount = gross.mul(li.discountRate).div(100);
      discountAmount = discountAmount.add(discount);
      const taxable = gross.sub(discount);
      const tax = taxable.mul(li.taxRate).div(100);
      taxAmount = taxAmount.add(tax);
      total = total.add(li.amount);
    }
    return { subtotal, discountAmount, taxAmount, total };
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async list(scope: UserScope, q: ListInvoicesQuery) {
    const workspaceId = this.requireWorkspace(scope);
    const where: Prisma.InvoiceWhereInput = { workspaceId };
    if (q.status) where.status = q.status;
    if (q.clientId) where.clientId = q.clientId;
    if (q.projectId) where.projectId = q.projectId;
    if (q.q) {
      where.OR = [
        { number: { contains: q.q, mode: 'insensitive' } },
        { client: { name: { contains: q.q, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.client.invoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          client: { select: { id: true, name: true } },
        },
      }),
      this.prisma.client.invoice.count({ where }),
    ]);
    return {
      items,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  async get(scope: UserScope, id: string): Promise<InvoiceWithItems> {
    const invoice = await this.requireInvoice(scope, id);
    return this.serialize(invoice);
  }

  async create(scope: UserScope, input: CreateInvoiceInput): Promise<InvoiceWithItems> {
    const workspaceId = this.requireWorkspace(scope);
    // Confirm the client belongs to this workspace.
    const client = await this.prisma.client.client.findFirst({
      where: { id: input.clientId, workspaceId },
      select: { id: true },
    });
    if (!client) {
      throw new BadRequestException({
        title: 'Invalid client',
        status: 400,
        detail: 'Client not found in this workspace.',
      });
    }

    await this.assertLinks(workspaceId, {
      projectId: input.projectId ?? null,
      contractId: input.contractId ?? null,
      milestoneId: input.milestoneId ?? null,
    });
    if (input.templateKey) await this.assertTemplate(input.templateKey);

    const issuedAt = input.issuedAt ?? new Date();
    const computed = input.lineItems.map((li) => this.computeLineItem(li));
    const totals = this.computeTotals(computed);

    const invoice = await this.prisma.client.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, workspaceId, issuedAt);
      return tx.invoice.create({
        data: {
          workspaceId,
          clientId: input.clientId,
          projectId: input.projectId ?? null,
          createdById: scope.userId,
          number,
          currency: input.currency ?? 'USD',
          issuedAt,
          dueAt: input.dueAt,
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount,
          total: totals.total,
          notes: input.notes ?? null,
          terms: input.terms ?? null,
          footer: input.footer ?? null,
          contractId: input.contractId ?? null,
          milestoneId: input.milestoneId ?? null,
          templateKey: input.templateKey ?? null,
          lineItems: {
            create: computed.map((c, i) => ({ ...c, position: i })),
          },
        },
        include: { lineItems: { orderBy: { position: 'asc' } }, payments: true },
      });
    });
    return this.serialize(invoice);
  }

  async update(scope: UserScope, id: string, input: UpdateInvoiceInput): Promise<InvoiceWithItems> {
    const existing = await this.requireInvoice(scope, id);
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException({
        title: 'Cannot edit',
        status: 400,
        detail: 'Only DRAFT invoices can be edited. Cancel and create a new one instead.',
      });
    }

    await this.assertLinks(this.requireWorkspace(scope), {
      projectId: input.projectId === undefined ? existing.projectId : input.projectId,
      contractId: input.contractId === undefined ? existing.contractId : input.contractId,
      milestoneId: input.milestoneId === undefined ? existing.milestoneId : input.milestoneId,
    });
    if (input.clientId) {
      const client = await this.prisma.client.client.findFirst({
        where: { id: input.clientId, workspaceId: existing.workspaceId },
        select: { id: true },
      });
      if (!client) {
        throw new BadRequestException({ title: 'Invalid client', status: 400 });
      }
    }
    if (input.templateKey) await this.assertTemplate(input.templateKey);

    let recomputed = false;
    let computed: ReturnType<InvoicesService['computeLineItem']>[] | null = null;
    if (input.lineItems) {
      computed = input.lineItems.map((li) => this.computeLineItem(li));
      recomputed = true;
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      if (input.lineItems && computed) {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
        await tx.invoiceLineItem.createMany({
          data: computed.map((c, i) => ({
            invoiceId: id,
            position: i,
            description: c.description,
            quantity: c.quantity,
            unitPrice: c.unitPrice,
            taxRate: c.taxRate,
            discountRate: c.discountRate,
            amount: c.amount,
          })),
        });
      }
      const data: Prisma.InvoiceUpdateInput = {};
      if (input.clientId) data.client = { connect: { id: input.clientId } };
      if (input.projectId !== undefined) {
        data.project = input.projectId
          ? { connect: { id: input.projectId } }
          : { disconnect: true };
      }
      if (input.currency) data.currency = input.currency;
      if (input.issuedAt) data.issuedAt = input.issuedAt;
      if (input.dueAt) data.dueAt = input.dueAt;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.terms !== undefined) data.terms = input.terms;
      if (input.footer !== undefined) data.footer = input.footer;
      if (input.contractId !== undefined) {
        data.contract = input.contractId
          ? { connect: { id: input.contractId } }
          : { disconnect: true };
      }
      if (input.milestoneId !== undefined) {
        data.milestone = input.milestoneId
          ? { connect: { id: input.milestoneId } }
          : { disconnect: true };
      }
      if (input.templateKey !== undefined) data.templateKey = input.templateKey;
      if (recomputed && computed) {
        const totals = this.computeTotals(computed);
        data.subtotal = totals.subtotal;
        data.discountAmount = totals.discountAmount;
        data.taxAmount = totals.taxAmount;
        data.total = totals.total;
      }
      return tx.invoice.update({
        where: { id },
        data,
        include: { lineItems: { orderBy: { position: 'asc' } }, payments: true },
      });
    });
    return this.serialize(updated);
  }

  async remove(scope: UserScope, id: string): Promise<void> {
    await this.requireInvoice(scope, id);
    await this.prisma.client.invoice.delete({ where: { id } });
  }

  /**
   * Send an invoice to the client.
   *
   * - `system`: render the PDF and email it from the platform address with a
   *   Reply-To of the organization's billing email. The status moves from
   *   DRAFT to SENT once the email is on the queue.
   * - `mailbox`: the user already sent it from their own mailbox through the
   *   compose dialog (so it sits in their Sent folder); only record it.
   *
   * Re-sending a SENT, PARTIALLY_PAID or OVERDUE invoice is allowed, which is
   * how reminders go out. Cancelled and refunded invoices cannot be sent.
   */
  async send(scope: UserScope, id: string, input: SendInvoiceInput = { via: 'mailbox' }): Promise<InvoiceWithItems> {
    const invoice = await this.requireInvoice(scope, id);
    if (invoice.status === 'CANCELLED' || invoice.status === 'REFUNDED') {
      throw new BadRequestException({
        title: 'Cannot send',
        status: 400,
        detail: 'Cancelled and refunded invoices cannot be sent.',
      });
    }

    if (input.via === 'system') {
      const pdf = await this.ensurePdf(scope, id);
      const { organizationId, settings } = await this.renderer.settingsFor(invoice.workspaceId);
      const queued = await this.email.sendInvoice({
        to: input.to,
        subject: input.subject,
        message: input.message ?? null,
        replyTo: settings.email ?? null,
        companyName: settings.companyName ?? 'The Botss',
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        totalLabel: formatMoney(invoice.total.sub(invoice.amountPaid).toFixed(2), invoice.currency),
        dueDateLabel: invoice.dueAt ? invoice.dueAt.toISOString().slice(0, 10) : null,
        workspaceId: invoice.workspaceId,
        organizationId,
        pdfFileId: pdf.fileId,
      });
      if (queued === 'not-configured') {
        throw new BadRequestException({
          title: 'System email is not configured',
          status: 400,
          detail: 'Send it from your mailbox instead, or ask an admin to configure SMTP.',
          code: 'system-mail-missing',
        });
      }
      if (queued === 'queue-failed') {
        throw new ServiceUnavailableException({
          title: "Couldn't queue the email",
          status: 503,
          detail: 'The invoice was not sent. Try again in a moment, or send it from your mailbox.',
          code: 'mail-queue-unavailable',
        });
      }
    }

    // Sent once the user has sent it (mailbox) or it is on the mail queue
    // (system). Waiting for SMTP delivery left invoices on DRAFT whenever the
    // mail transport was slow or retrying.
    await this.prisma.client.invoice.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'SENT' },
    });
    return this.get(scope, id);
  }

  /**
   * Manual status change: mark sent without emailing, move an unpaid SENT
   * invoice back to DRAFT, or cancel an unpaid invoice. Paid states are never
   * set here - they follow recorded payments (see PaymentsService).
   *
   * The `where` re-checks the source status so a concurrent payment or send
   * cannot be overwritten by a stale request.
   */
  async setStatus(
    scope: UserScope,
    id: string,
    input: SetInvoiceStatusInput,
  ): Promise<InvoiceWithItems> {
    const invoice = await this.requireInvoice(scope, id);
    const unpaid = new D(invoice.amountPaid).lte(0);
    const from: Record<SetInvoiceStatusInput['status'], InvoiceStatus[]> = {
      SENT: ['DRAFT'],
      DRAFT: ['SENT', 'OVERDUE'],
      CANCELLED: ['DRAFT', 'SENT', 'OVERDUE'],
    };
    const allowed = from[input.status] ?? [];
    if (invoice.status === input.status) return this.get(scope, id);
    if (!allowed.includes(invoice.status) || !unpaid) {
      throw new ConflictException({
        title: 'Status change not allowed',
        status: 409,
        detail: unpaid
          ? `A ${invoice.status.toLowerCase().replace('_', ' ')} invoice cannot be marked ${input.status.toLowerCase()}.`
          : 'This invoice has payments recorded. Void them first.',
        code: 'invalid_status_transition',
      });
    }
    const { count } = await this.prisma.client.invoice.updateMany({
      where: { id, status: { in: allowed }, amountPaid: { lte: 0 } },
      data: { status: input.status },
    });
    if (count === 0) {
      throw new ConflictException({
        title: 'Invoice changed',
        status: 409,
        detail: 'The invoice was updated by someone else. Reload and try again.',
        code: 'invoice_changed',
      });
    }
    return this.get(scope, id);
  }

  /**
   * Recording a payment against an invoice DELEGATES to PaymentsService.
   *
   * Payment is now the single money-in record, and an invoice raised against a
   * contract must advance that contract too. PaymentsService owns the FX
   * maths, the currency assertion, the contract/milestone recalculation and
   * the invoice status sync - duplicating any of it here would guarantee the
   * two drift apart.
   */
  async recordPayment(
    scope: UserScope,
    id: string,
    input: RecordPaymentInput,
  ): Promise<InvoiceWithItems> {
    const invoice = await this.requireInvoice(scope, id);
    if (new D(input.amount).lte(0)) {
      throw new BadRequestException({
        title: 'Invalid amount',
        status: 400,
        detail: 'Payment amount must be greater than zero.',
        code: 'invalid_amount',
      });
    }
    // Pass the invoice's currency so PaymentsService rejects an invoice whose
    // currency differs from its contract's, instead of booking the balance in
    // the contract's units.
    await this.payments.create(scope, { ...input, invoiceId: id, currency: invoice.currency });
    // PaymentsService already recomputed amountPaid + status inside its own
    // transaction, so this is a plain re-read of the updated row.
    return this.get(scope, id);
  }

  /**
   * Render the invoice to PDF and store it, or reuse the stored PDF when the
   * rendered HTML has not changed since (same content hash). Returns the file
   * id (for mail attachments) and its download URL.
   */
  async ensurePdf(scope: UserScope, id: string): Promise<InvoicePdfResponse> {
    // Authorize BEFORE joining an in-flight render: the shared render must
    // never hand one caller's invoice to a caller who cannot see it.
    const invoice = await this.requireInvoice(scope, id);
    return this.renderOnce(
      { id: invoice.id, workspaceId: invoice.workspaceId, pdfFileId: invoice.pdfFileId },
      scope.userId,
    );
  }

  /**
   * The client portal's way to an invoice PDF: a non-draft invoice of this
   * client, in the client's workspace. No CASL here - the portal scope has
   * already established who is asking. The client is never recorded as the
   * file's uploader; the invoice's creator is.
   */
  async ensurePdfForPortal(
    workspaceId: string,
    clientId: string,
    id: string,
  ): Promise<InvoicePdfResponse> {
    const invoice = await this.prisma.client.invoice.findFirst({
      where: { id, workspaceId, clientId, status: { not: 'DRAFT' } },
      select: { id: true, workspaceId: true, pdfFileId: true, createdById: true },
    });
    if (!invoice) {
      throw new NotFoundException({ title: 'Invoice not found', status: 404 });
    }
    return this.renderOnce(invoice, invoice.createdById);
  }

  /** In-flight renders are shared per invoice, so double clicks cost one render. */
  private renderOnce(
    invoice: { id: string; workspaceId: string; pdfFileId: string | null },
    uploadedById: string,
  ): Promise<InvoicePdfResponse> {
    const inflight = this.pdfRenders.get(invoice.id);
    if (inflight) return inflight;
    const run = this.renderPdf(invoice, uploadedById).finally(() =>
      this.pdfRenders.delete(invoice.id),
    );
    this.pdfRenders.set(invoice.id, run);
    return run;
  }

  private async renderPdf(
    invoice: { id: string; workspaceId: string; pdfFileId: string | null },
    uploadedById: string,
  ): Promise<InvoicePdfResponse> {
    const id = invoice.id;
    const doc = await this.renderer.renderSaved(invoice.workspaceId, id);
    const hash = createHash('sha256').update(doc.html).digest('hex');

    if (invoice.pdfFileId) {
      const existing = await this.prisma.client.fileObject.findFirst({
        where: { id: invoice.pdfFileId, workspaceId: invoice.workspaceId },
        select: { id: true, url: true, checksum: true, filename: true },
      });
      if (existing && existing.checksum === hash && existing.url) {
        return { fileId: existing.id, url: existing.url, filename: existing.filename };
      }
    }

    const bytes = await this.pdf.htmlToPdf(doc.html, { paper: doc.paper, marginsMm: doc.marginsMm });
    const stored = await this.files.putBuffer({
      workspaceId: invoice.workspaceId,
      uploadedById,
      filename: doc.filename,
      mimeType: 'application/pdf',
      body: bytes,
      kind: 'PDF',
    });
    await this.prisma.client.fileObject.update({
      where: { id: stored.id },
      data: { checksum: hash },
    });
    // Raw update: a plain `update` would bump `updatedAt`, which would make
    // every PDF look stale to the list's "edited since" badge.
    await this.prisma.raw.$executeRaw`UPDATE "Invoice" SET "pdfFileId" = ${stored.id} WHERE "id" = ${id}`;
    return { fileId: stored.id, url: stored.url ?? '', filename: stored.filename };
  }

  async generatePdfUrl(scope: UserScope, id: string): Promise<InvoicePdfResponse> {
    return this.ensurePdf(scope, id);
  }

  // -------------------------------------------------------------------------
  // Templates, preview, branding
  // -------------------------------------------------------------------------

  async listTemplates(scope: UserScope): Promise<InvoiceTemplateList> {
    const workspaceId = this.requireWorkspace(scope);
    const [items, { settings }] = await Promise.all([
      this.templates.list(),
      this.renderer.settingsFor(workspaceId),
    ]);
    const defaultKey = await this.renderer.resolveTemplateKey(null, settings);
    return { items, defaultKey: items.length > 0 ? defaultKey : DEFAULT_TEMPLATE_KEY };
  }

  async preview(scope: UserScope, input: InvoicePreviewInput): Promise<string> {
    const workspaceId = this.requireWorkspace(scope);
    return this.renderer.renderPreview(workspaceId, input);
  }

  async getSettings(scope: UserScope): Promise<InvoiceSettingsResponse> {
    const workspaceId = this.requireWorkspace(scope);
    const { settings } = await this.renderer.settingsFor(workspaceId);
    let logoUrl: string | null = null;
    if (settings.logoFileId) {
      const file = await this.prisma.client.fileObject.findFirst({
        where: { id: settings.logoFileId, workspaceId },
        select: { url: true },
      });
      logoUrl = file?.url ?? null;
    }
    return { ...settings, logoUrl };
  }

  async updateSettings(scope: UserScope, input: InvoiceSettings): Promise<InvoiceSettingsResponse> {
    const workspaceId = this.requireWorkspace(scope);
    const parsed = invoiceSettingsSchema.parse(input);
    if (parsed.logoFileId) {
      const logo = await this.prisma.client.fileObject.findFirst({
        where: { id: parsed.logoFileId, workspaceId },
        select: { mimeType: true },
      });
      if (!logo || !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(logo.mimeType)) {
        throw new BadRequestException({
          title: 'Invalid logo',
          status: 400,
          detail: 'Upload a PNG, JPEG, WebP, GIF or SVG image in this workspace first.',
        });
      }
    }
    if (parsed.defaultTemplateKey) await this.assertTemplate(parsed.defaultTemplateKey);
    const ws = await this.prisma.client.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    await this.prisma.client.organization.update({
      where: { id: ws.organizationId },
      data: { invoiceSettings: parsed as Prisma.InputJsonValue },
    });
    return this.getSettings(scope);
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private async assertTemplate(key: string): Promise<void> {
    const exists = (await this.templates.list()).some((t) => t.key === key);
    if (!exists) {
      throw new BadRequestException({
        title: 'Unknown invoice template',
        status: 400,
        detail: `No template folder named "${key}".`,
      });
    }
  }

  /** Project, contract and milestone must all live in the invoice's workspace. */
  private async assertLinks(
    workspaceId: string,
    links: { projectId: string | null; contractId: string | null; milestoneId: string | null },
  ): Promise<void> {
    if (links.projectId) {
      const project = await this.prisma.client.project.findFirst({
        where: { id: links.projectId, workspaceId },
        select: { id: true },
      });
      if (!project) throw new BadRequestException({ title: 'Invalid project', status: 400 });
    }
    let contractId = links.contractId;
    if (links.milestoneId) {
      const milestone = await this.prisma.client.contractMilestone.findFirst({
        where: { id: links.milestoneId, contract: { workspaceId } },
        select: { contractId: true },
      });
      if (!milestone) throw new BadRequestException({ title: 'Invalid milestone', status: 400 });
      if (contractId && contractId !== milestone.contractId) {
        throw new BadRequestException({
          title: 'Milestone belongs to a different contract',
          status: 400,
        });
      }
      contractId = milestone.contractId;
    }
    if (contractId) {
      const contract = await this.prisma.client.contract.findFirst({
        where: { id: contractId, workspaceId },
        select: { id: true },
      });
      if (!contract) throw new BadRequestException({ title: 'Invalid contract', status: 400 });
    }
  }

  // -------------------------------------------------------------------------
  // Serialization - Decimal → string round-trip for the wire schema.
  // -------------------------------------------------------------------------

  private serialize(invoice: Prisma.InvoiceGetPayload<{
    include: { lineItems: true; payments: true };
  }>): InvoiceWithItems {
    return {
      id: invoice.id,
      workspaceId: invoice.workspaceId,
      clientId: invoice.clientId,
      projectId: invoice.projectId,
      createdById: invoice.createdById,
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      subtotal: invoice.subtotal.toString(),
      discountAmount: invoice.discountAmount.toString(),
      taxAmount: invoice.taxAmount.toString(),
      total: invoice.total.toString(),
      amountPaid: invoice.amountPaid.toString(),
      notes: invoice.notes,
      terms: invoice.terms,
      footer: invoice.footer,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
      deletedAt: invoice.deletedAt,
      contractId: invoice.contractId,
      milestoneId: invoice.milestoneId,
      pdfFileId: invoice.pdfFileId,
      templateKey: invoice.templateKey,
      lineItems: invoice.lineItems.map((li) => ({
        id: li.id,
        invoiceId: li.invoiceId,
        position: li.position,
        description: li.description,
        quantity: li.quantity.toString(),
        unitPrice: li.unitPrice.toString(),
        taxRate: li.taxRate.toString(),
        discountRate: li.discountRate.toString(),
        amount: li.amount.toString(),
        createdAt: li.createdAt,
        updatedAt: li.updatedAt,
      })),
      payments: invoice.payments.map((p) => ({
        id: p.id,
        workspaceId: p.workspaceId,
        invoiceId: p.invoiceId,
        contractId: p.contractId,
        milestoneId: p.milestoneId,
        paymentSourceId: p.paymentSourceId,
        amount: p.amount.toFixed(2),
        currency: p.currency,
        receivedAmount: p.receivedAmount.toFixed(2),
        receivedCurrency: p.receivedCurrency,
        feeAmount: p.feeAmount.toFixed(2),
        fxRate: p.fxRate.toFixed(8),
        baseAmount: p.baseAmount.toFixed(2),
        region: p.region,
        reference: p.reference,
        paidAt: p.paidAt,
        notes: p.notes,
        recordedById: p.recordedById,
        voidedAt: p.voidedAt,
        voidReason: p.voidReason,
        voidedById: p.voidedById,
        method: p.method,
        externalId: p.externalId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    };
  }
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  try {
    // 2dp regardless of ICU currency data (see the `money` template helper).
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
