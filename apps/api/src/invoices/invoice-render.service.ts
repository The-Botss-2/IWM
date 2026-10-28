import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@botss/database';
import {
  invoiceSettingsSchema,
  type InvoicePreviewInput,
  type InvoiceSettings,
} from '@botss/shared-types';

import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_TEMPLATE_KEY, InvoiceTemplatesService } from './invoice-templates.service';
import { escapeHtml } from './template-engine';

const D = Prisma.Decimal;

const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Everything a template can read (see "Invoice and payslip templates" in the README). */
export interface InvoiceViewModel {
  invoice: {
    number: string;
    status: string;
    isDraft: boolean;
    isPaid: boolean;
    currency: string;
    issuedAt: Date;
    dueAt: Date | null;
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    amountPaid: string;
    balanceDue: string;
    notes: string | null;
    terms: string | null;
    footer: string | null;
  };
  client: {
    name: string;
    legalName: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    taxId: string | null;
    addressLines: string[];
    address: string | null;
  };
  project: { name: string } | null;
  contract: { title: string } | null;
  company: {
    name: string;
    logo: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    taxId: string | null;
    bankDetails: string | null;
    paymentTerms: string | null;
    footer: string | null;
    accentColor: string;
  };
  lineItems: Array<{
    position: number;
    description: string;
    quantity: string;
    unitPrice: string;
    taxRate: string;
    discountRate: string;
    amount: string;
  }>;
}

interface LineInput {
  description: string;
  quantity?: string | number;
  unitPrice?: string | number;
  taxRate?: string | number;
  discountRate?: string | number;
}

function dec(value: string | number | undefined, fallback: number): Prisma.Decimal {
  try {
    if (value === undefined || value === '') return new D(fallback);
    return new D(value);
  } catch {
    return new D(fallback);
  }
}

/** Same arithmetic as InvoicesService.computeLineItem, for unsaved previews. */
export function computeLines(lines: LineInput[]) {
  let subtotal = new D(0);
  let discount = new D(0);
  let tax = new D(0);
  let total = new D(0);
  const items = lines.map((line, index) => {
    const quantity = dec(line.quantity, 1);
    const unitPrice = dec(line.unitPrice, 0);
    const taxRate = dec(line.taxRate, 0);
    const discountRate = dec(line.discountRate, 0);
    const gross = quantity.mul(unitPrice);
    const lineDiscount = gross.mul(discountRate).div(100);
    const taxable = gross.sub(lineDiscount);
    const lineTax = taxable.mul(taxRate).div(100);
    const amount = taxable.add(lineTax);
    subtotal = subtotal.add(gross);
    discount = discount.add(lineDiscount);
    tax = tax.add(lineTax);
    total = total.add(amount);
    return {
      position: index + 1,
      description: line.description,
      quantity: quantity.toString(),
      unitPrice: unitPrice.toFixed(2),
      taxRate: taxRate.toString(),
      discountRate: discountRate.toString(),
      amount: amount.toFixed(2),
    };
  });
  return {
    items,
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
  };
}

/**
 * Builds the view model for an invoice (saved or still being edited) and
 * renders it through the chosen HTML template into a complete, self-contained
 * document: template CSS inline, logo inline, no external requests.
 */
@Injectable()
export class InvoiceRenderService {
  private readonly logger = new Logger(InvoiceRenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: InvoiceTemplatesService,
    private readonly files: FilesService,
  ) {}

  async settingsFor(
    workspaceId: string,
  ): Promise<{ organizationId: string; settings: InvoiceSettings }> {
    const ws = await this.prisma.client.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: {
        organizationId: true,
        organization: { select: { invoiceSettings: true, name: true } },
      },
    });
    const parsed = invoiceSettingsSchema.safeParse(ws.organization.invoiceSettings ?? {});
    const settings: InvoiceSettings = parsed.success ? parsed.data : {};
    if (!settings.companyName) settings.companyName = ws.organization.name;
    return { organizationId: ws.organizationId, settings };
  }

  /** Resolve which template renders an invoice: its own, the org default, or built-in. */
  async resolveTemplateKey(
    explicit: string | null | undefined,
    settings: InvoiceSettings,
  ): Promise<string> {
    const available = new Set((await this.templates.list()).map((t) => t.key));
    for (const key of [explicit, settings.defaultTemplateKey, DEFAULT_TEMPLATE_KEY]) {
      if (key && available.has(key)) return key;
    }
    return DEFAULT_TEMPLATE_KEY;
  }

  async renderSaved(
    workspaceId: string,
    invoiceId: string,
  ): Promise<{
    html: string;
    paper: 'A4' | 'Letter';
    marginsMm: { top: number; right: number; bottom: number; left: number };
    filename: string;
  }> {
    const invoice = await this.prisma.client.invoice.findFirstOrThrow({
      where: { id: invoiceId, workspaceId },
      include: {
        lineItems: { orderBy: { position: 'asc' } },
        client: true,
        project: { select: { name: true } },
        contract: { select: { title: true } },
      },
    });
    const { settings } = await this.settingsFor(workspaceId);
    const balance = invoice.total.sub(invoice.amountPaid);
    const vm: InvoiceViewModel = {
      invoice: {
        number: invoice.number,
        status: invoice.status,
        isDraft: invoice.status === 'DRAFT',
        isPaid: invoice.status === 'PAID',
        currency: invoice.currency,
        issuedAt: invoice.issuedAt,
        dueAt: invoice.dueAt,
        subtotal: invoice.subtotal.toFixed(2),
        discount: invoice.discountAmount.toFixed(2),
        tax: invoice.taxAmount.toFixed(2),
        total: invoice.total.toFixed(2),
        amountPaid: invoice.amountPaid.toFixed(2),
        balanceDue: (balance.isNegative() ? new D(0) : balance).toFixed(2),
        notes: invoice.notes,
        terms: invoice.terms ?? settings.paymentTerms ?? null,
        footer: invoice.footer ?? settings.footer ?? null,
      },
      client: this.clientView(invoice.client),
      project: invoice.project ? { name: invoice.project.name } : null,
      contract: invoice.contract ? { title: invoice.contract.title } : null,
      company: await this.companyView(workspaceId, settings),
      lineItems: invoice.lineItems.map((li, i) => ({
        position: i + 1,
        description: li.description,
        quantity: li.quantity.toString(),
        unitPrice: li.unitPrice.toFixed(2),
        taxRate: li.taxRate.toString(),
        discountRate: li.discountRate.toString(),
        amount: li.amount.toFixed(2),
      })),
    };
    const key = await this.resolveTemplateKey(invoice.templateKey, settings);
    const doc = await this.renderDocument(key, vm);
    return { ...doc, filename: `${invoice.number}.pdf` };
  }

  /** Render unsaved editor state. Falls back to the saved invoice for missing fields. */
  async renderPreview(workspaceId: string, input: InvoicePreviewInput): Promise<string> {
    const saved = input.invoiceId
      ? await this.prisma.client.invoice.findFirst({
          where: { id: input.invoiceId, workspaceId },
          include: { lineItems: { orderBy: { position: 'asc' } } },
        })
      : null;
    const clientId = input.clientId ?? saved?.clientId;
    const client = clientId
      ? await this.prisma.client.client.findFirst({ where: { id: clientId, workspaceId } })
      : null;
    const projectId = input.projectId === undefined ? saved?.projectId : input.projectId;
    const project = projectId
      ? await this.prisma.client.project.findFirst({
          where: { id: projectId, workspaceId },
          select: { name: true },
        })
      : null;
    const { settings } = await this.settingsFor(workspaceId);

    const lines: LineInput[] =
      input.lineItems ??
      saved?.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity.toString(),
        unitPrice: li.unitPrice.toString(),
        taxRate: li.taxRate.toString(),
        discountRate: li.discountRate.toString(),
      })) ??
      [];
    const totals = computeLines(lines.filter((l) => l.description.trim().length > 0));
    const amountPaid = saved ? saved.amountPaid : new D(0);
    const balance = new D(totals.total).sub(amountPaid);
    const currency = input.currency ?? saved?.currency ?? settings.defaultCurrency ?? 'USD';

    const vm: InvoiceViewModel = {
      invoice: {
        number: saved?.number ?? 'DRAFT',
        status: saved?.status ?? 'DRAFT',
        isDraft: (saved?.status ?? 'DRAFT') === 'DRAFT',
        isPaid: saved?.status === 'PAID',
        currency,
        issuedAt: input.issuedAt ?? saved?.issuedAt ?? new Date(),
        dueAt: input.dueAt ?? saved?.dueAt ?? null,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        total: totals.total,
        amountPaid: amountPaid.toFixed(2),
        balanceDue: (balance.isNegative() ? new D(0) : balance).toFixed(2),
        notes: input.notes === undefined ? (saved?.notes ?? null) : input.notes,
        terms:
          (input.terms === undefined ? saved?.terms : input.terms) ?? settings.paymentTerms ?? null,
        footer:
          (input.footer === undefined ? saved?.footer : input.footer) ?? settings.footer ?? null,
      },
      client: client
        ? this.clientView(client)
        : {
            name: 'Client name',
            legalName: null,
            email: null,
            phone: null,
            website: null,
            taxId: null,
            addressLines: [],
            address: null,
          },
      project: project ? { name: project.name } : null,
      contract: null,
      company: await this.companyView(workspaceId, settings),
      lineItems: totals.items,
    };
    const key = await this.resolveTemplateKey(input.templateKey ?? saved?.templateKey, settings);
    return (await this.renderDocument(key, vm)).html;
  }

  private clientView(client: {
    name: string;
    legalName: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    taxId: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  }): InvoiceViewModel['client'] {
    const cityLine = [client.city, client.state, client.postalCode].filter(Boolean).join(', ');
    const addressLines = [
      client.addressLine1,
      client.addressLine2,
      cityLine,
      client.country,
    ].filter((v): v is string => Boolean(v && v.trim()));
    return {
      name: client.name,
      legalName: client.legalName,
      email: client.email,
      phone: client.phone,
      website: client.website,
      taxId: client.taxId,
      addressLines,
      address: addressLines.length > 0 ? addressLines.join('\n') : null,
    };
  }

  /**
   * The organization's document branding (name, logo, address, accent
   * colour), for documents other than invoices: payroll payslips use it so
   * every PDF the company sends looks the same.
   */
  async brandingFor(workspaceId: string): Promise<InvoiceViewModel['company']> {
    const { settings } = await this.settingsFor(workspaceId);
    return this.companyView(workspaceId, settings);
  }

  private async companyView(
    workspaceId: string,
    settings: InvoiceSettings,
  ): Promise<InvoiceViewModel['company']> {
    let logo: string | null = null;
    if (settings.logoFileId) {
      try {
        const file = await this.files.getObjectBuffer(workspaceId, settings.logoFileId);
        if (file && LOGO_MIME.has(file.mimeType) && file.body.byteLength <= MAX_LOGO_BYTES) {
          logo = `data:${file.mimeType};base64,${file.body.toString('base64')}`;
        }
      } catch (err) {
        this.logger.warn(
          `Invoice logo could not be loaded: ${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
    return {
      name: settings.companyName ?? 'Your company',
      logo,
      address: settings.address ?? null,
      email: settings.email ?? null,
      phone: settings.phone ?? null,
      website: settings.website ?? null,
      taxId: settings.taxId ?? null,
      bankDetails: settings.bankDetails ?? null,
      paymentTerms: settings.paymentTerms ?? null,
      footer: settings.footer ?? null,
      accentColor: settings.accentColor ?? '#7b6fe8',
    };
  }

  private async renderDocument(key: string, vm: InvoiceViewModel) {
    const template = await this.templates.load(key);
    const body = template.compiled.render(vm);
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(vm.invoice.number)}</title>
<style>
@page { size: ${template.meta.paper}; }
${template.css}
</style>
</head>
<body>
${body}
</body>
</html>`;
    return { html, paper: template.meta.paper, marginsMm: template.meta.marginsMm };
  }
}
