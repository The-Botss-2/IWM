import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@botss/database';
import {
  portalContractListSchema,
  portalInvoiceDetailSchema,
  portalInvoiceListSchema,
  portalPaymentListSchema,
  type PortalContractList,
  type PortalInvoiceDetail,
  type PortalInvoiceList,
  type PortalOutstanding,
  type PortalPaymentList,
} from '@botss/shared-types';

import { FilesService } from '../files/files.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PORTAL_OPEN_INVOICE_STATUSES,
  portalContractWhere,
  portalInvoiceWhere,
} from './portal-rules';
import { PortalScopeService, type PortalContact } from './portal-scope';

const LIST_LIMIT = 200;

const INVOICE_SUMMARY_SELECT = {
  id: true,
  number: true,
  status: true,
  currency: true,
  issuedAt: true,
  dueAt: true,
  total: true,
  amountPaid: true,
  project: { select: { name: true } },
} as const;

type InvoiceSummaryRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SUMMARY_SELECT }>;

function money(d: Prisma.Decimal): string {
  return d.toFixed(2);
}

function invoiceSummary(row: InvoiceSummaryRow) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    total: money(row.total),
    amountPaid: money(row.amountPaid),
    balance: money(row.total.minus(row.amountPaid)),
    projectName: row.project?.name ?? null,
  };
}

/**
 * Billing in the portal: the main contact only (`require(..., { billing })`).
 * Every response goes through an allowlist schema - no notes on contracts,
 * no FX, base-currency, fee, received-amount or reference fields, ever.
 */
@Injectable()
export class PortalBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PortalScopeService,
    private readonly invoices: InvoicesService,
    private readonly files: FilesService,
  ) {}

  async listInvoices(userId: string, clientId: string): Promise<PortalInvoiceList> {
    const contact = await this.scope.require(userId, clientId, { billing: true });
    const rows = await this.prisma.client.invoice.findMany({
      where: portalInvoiceWhere(contact),
      orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
      take: LIST_LIMIT,
      select: INVOICE_SUMMARY_SELECT,
    });
    return portalInvoiceListSchema.parse({ items: rows.map(invoiceSummary) });
  }

  async getInvoice(
    userId: string,
    clientId: string,
    invoiceId: string,
  ): Promise<PortalInvoiceDetail> {
    const contact = await this.scope.require(userId, clientId, { billing: true });
    const row = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, ...portalInvoiceWhere(contact) },
      select: {
        ...INVOICE_SUMMARY_SELECT,
        subtotal: true,
        discountAmount: true,
        taxAmount: true,
        notes: true,
        terms: true,
        footer: true,
        contract: { select: { title: true } },
        lineItems: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            description: true,
            quantity: true,
            unitPrice: true,
            taxRate: true,
            discountRate: true,
            amount: true,
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException({ title: 'Invoice not found', status: 404 });
    }
    return portalInvoiceDetailSchema.parse({
      ...invoiceSummary(row),
      subtotal: money(row.subtotal),
      discountAmount: money(row.discountAmount),
      taxAmount: money(row.taxAmount),
      notes: row.notes,
      terms: row.terms,
      footer: row.footer,
      contractTitle: row.contract?.title ?? null,
      lineItems: row.lineItems.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: money(l.quantity),
        unitPrice: money(l.unitPrice),
        taxRate: money(l.taxRate),
        discountRate: money(l.discountRate),
        amount: money(l.amount),
      })),
    });
  }

  /** PDF bytes streamed through the API; the storage URL never reaches a client. */
  async invoicePdf(
    userId: string,
    clientId: string,
    invoiceId: string,
  ): Promise<{ body: Buffer; filename: string }> {
    const contact = await this.scope.require(userId, clientId, { billing: true });
    const pdf = await this.invoices.ensurePdfForPortal(
      contact.workspaceId,
      contact.clientId,
      invoiceId,
    );
    const file = await this.files.getObjectBuffer(contact.workspaceId, pdf.fileId);
    if (!file) {
      throw new NotFoundException({ title: 'Invoice PDF not found', status: 404 });
    }
    return { body: file.body, filename: pdf.filename };
  }

  async listContracts(userId: string, clientId: string): Promise<PortalContractList> {
    const contact = await this.scope.require(userId, clientId, { billing: true });
    const rows = await this.prisma.client.contract.findMany({
      where: portalContractWhere(contact),
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      select: {
        id: true,
        title: true,
        billingModel: true,
        status: true,
        currency: true,
        totalValue: true,
        amountPaid: true,
        paymentStatus: true,
        startDate: true,
        endDate: true,
        project: { select: { name: true } },
        milestones: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            amount: true,
            amountPaid: true,
            status: true,
            paymentStatus: true,
            dueDate: true,
            deliveredAt: true,
          },
        },
      },
    });
    return portalContractListSchema.parse({
      items: rows.map((c) => ({
        id: c.id,
        title: c.title,
        billingModel: c.billingModel,
        status: c.status,
        currency: c.currency,
        totalValue: money(c.totalValue),
        amountPaid: money(c.amountPaid),
        balance: money(c.totalValue.minus(c.amountPaid)),
        paymentStatus: c.paymentStatus,
        startDate: c.startDate,
        endDate: c.endDate,
        projectName: c.project?.name ?? null,
        milestones: c.milestones.map((m) => ({
          id: m.id,
          title: m.title,
          amount: money(m.amount),
          amountPaid: money(m.amountPaid),
          status: m.status,
          paymentStatus: m.paymentStatus,
          dueDate: m.dueDate,
          deliveredAt: m.deliveredAt,
        })),
      })),
    });
  }

  async listPayments(userId: string, clientId: string): Promise<PortalPaymentList> {
    const contact = await this.scope.require(userId, clientId, { billing: true });
    const rows = await this.prisma.client.payment.findMany({
      where: {
        workspaceId: contact.workspaceId,
        // Payment is voided, never soft-deleted: filter voids by hand.
        voidedAt: null,
        OR: [{ invoice: portalInvoiceWhere(contact) }, { contract: portalContractWhere(contact) }],
      },
      orderBy: { paidAt: 'desc' },
      take: LIST_LIMIT,
      select: {
        id: true,
        amount: true,
        currency: true,
        paidAt: true,
        invoice: { select: { number: true, status: true, deletedAt: true, clientId: true } },
        contract: {
          select: {
            title: true,
            status: true,
            deletedAt: true,
            clientId: true,
            project: { select: { clientId: true, portalVisible: true } },
          },
        },
      },
    });
    return portalPaymentListSchema.parse({
      items: rows.map((p) => ({
        id: p.id,
        amount: money(p.amount),
        currency: p.currency,
        paidAt: p.paidAt,
        // A payment may carry both links, and nothing forces them onto the
        // same client; name each only if THIS client may see it on its own.
        invoiceNumber:
          p.invoice &&
          p.invoice.clientId === contact.clientId &&
          p.invoice.status !== 'DRAFT' &&
          !p.invoice.deletedAt
            ? p.invoice.number
            : null,
        contractTitle:
          p.contract &&
          (p.contract.clientId === contact.clientId ||
            (p.contract.clientId === null &&
              p.contract.project?.clientId === contact.clientId &&
              p.contract.project?.portalVisible === true)) &&
          p.contract.status !== 'DRAFT' &&
          !p.contract.deletedAt
            ? p.contract.title
            : null,
      })),
    });
  }

  /** Money still owed on open invoices, one row per currency (never mixed). */
  async outstanding(contact: PortalContact): Promise<PortalOutstanding[]> {
    const rows = await this.prisma.client.invoice.findMany({
      where: { ...portalInvoiceWhere(contact), status: { in: [...PORTAL_OPEN_INVOICE_STATUSES] } },
      select: { currency: true, total: true, amountPaid: true },
    });
    const byCurrency = new Map<string, { amount: Prisma.Decimal; invoiceCount: number }>();
    for (const r of rows) {
      const due = r.total.minus(r.amountPaid);
      if (due.lte(0)) continue;
      const cur = byCurrency.get(r.currency) ?? { amount: new Prisma.Decimal(0), invoiceCount: 0 };
      byCurrency.set(r.currency, {
        amount: cur.amount.plus(due),
        invoiceCount: cur.invoiceCount + 1,
      });
    }
    return [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, v]) => ({
        currency,
        amount: money(v.amount),
        invoiceCount: v.invoiceCount,
      }));
  }
}
