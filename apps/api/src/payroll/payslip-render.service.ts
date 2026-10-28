import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { InvoiceRenderService, type InvoiceViewModel } from '../invoices/invoice-render.service';
import { TEMPLATE_HELPERS } from '../invoices/invoice-templates.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import { compileTemplate, type CompiledTemplate } from '../invoices/template-engine';
import { maskAccount, periodLabel } from './payroll-math';

/** Everything the payslip template can read. */
export interface PayslipViewModel {
  company: InvoiceViewModel['company'];
  period: { label: string; year: number; month: number };
  payDate: Date | null;
  employee: {
    name: string;
    designation: string | null;
    cnic: string | null;
    dateOfJoining: Date | null;
    /** "Bank transfer", "Cash" or "Cheque". */
    paymentMethod: string;
    /** Bank and account rows show only for a bank transfer. */
    isBankTransfer: boolean;
    bankName: string | null;
    /** In full, as on the payslips the team already issues. */
    accountNumber: string | null;
    accountMasked: string | null;
  };
  amounts: {
    salary: string;
    bonus: string;
    commission: string;
    deduction: string;
    tax: string;
    net: string;
    currency: string;
  };
  bonusNote: string | null;
  deductionNote: string | null;
  generatedAt: Date;
}

export interface PayslipSource {
  employeeName: string;
  designation: string | null;
  bankName: string | null;
  accountNumber: string | null;
  cnic: string | null;
  dateOfJoining: Date | null;
  paymentMethod: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';
  salary: string;
  bonus: string;
  commission: string;
  deduction: string;
  tax: string;
  net: string;
  bonusNote: string | null;
  deductionNote: string | null;
}

const PAYMENT_METHOD_LABELS: Record<PayslipSource['paymentMethod'], string> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  CHEQUE: 'Cheque',
};

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "September 2026". */
export function longPeriodLabel(year: number, month: number): string {
  return `${LONG_MONTHS[month - 1] ?? periodLabel(year, month)} ${year}`;
}

export const PAYSLIP_PAPER = 'A4' as const;
/** No page margins: the colour bars run to the paper edge; styles.css pads the content. */
export const PAYSLIP_MARGINS_MM = { top: 0, right: 0, bottom: 0, left: 0 };

/** Optional images in the template folder (the operator's logo and signed stamp). */
const ASSET_FILES = { logo: 'logo.png', stamp: 'stamp.png' } as const;
type Assets = Partial<Record<keyof typeof ASSET_FILES, string>>;
/** An image larger than this is skipped: it would bloat every PDF. */
const MAX_ASSET_BYTES = 1_000_000;

/**
 * Who signs the platform operator's own payslips, from PAYSLIP_SIGNATORY_NAME
 * and PAYSLIP_SIGNATORY_TITLE. Unset name = no signatory block. The template
 * folder's logo, the signed stamp and this name belong to the operator and
 * appear only on the root organization's payslips: any organization can sign
 * up to the platform and must never be able to print the operator's signature.
 */
function rootSignatory(): { name: string; title: string } | null {
  const name = process.env.PAYSLIP_SIGNATORY_NAME?.trim();
  if (!name) return null;
  return { name, title: process.env.PAYSLIP_SIGNATORY_TITLE?.trim() ?? '' };
}

/** What a payslip may carry beyond the organization's own branding. */
export function payslipExtras(organizationId: string): {
  own: boolean;
  signatory: { name: string; title: string } | null;
} {
  const own = organizationId === ROOT_ORG_ID;
  return { own, signatory: own ? rootSignatory() : null };
}

/**
 * Renders payslips through the invoice template engine, with the company
 * branding the invoices use. One built-in template lives in
 * apps/api/payslip-templates/default; it is reloaded when its files change,
 * like the invoice templates.
 */
@Injectable()
export class PayslipRenderService {
  /** dist/payroll/*.js and src/payroll/*.ts both sit two levels below apps/api. */
  readonly rootDir =
    process.env.PAYSLIP_TEMPLATES_DIR?.trim() ||
    path.resolve(__dirname, '..', '..', 'payslip-templates', 'default');

  private readonly logger = new Logger(PayslipRenderService.name);
  private cache: { stamp: string; compiled: CompiledTemplate; css: string; assets: Assets } | null =
    null;

  constructor(private readonly invoiceRender: InvoiceRenderService) {}

  /**
   * View models for these items of one run, sharing one branding lookup.
   * Pass `company` (from `company()`) when rendering many documents for one
   * batch, so the branding and its inlined logo are resolved once, not per
   * document.
   */
  async viewModels(
    workspaceId: string,
    run: { year: number; month: number; paidAt: Date | null },
    items: PayslipSource[],
    company?: InvoiceViewModel['company'],
  ): Promise<PayslipViewModel[]> {
    company ??= await this.invoiceRender.brandingFor(workspaceId);
    const generatedAt = new Date();
    return items.map((item) => buildPayslipViewModel(company, run, item, generatedAt));
  }

  /** The company the payslips (and their emails) come from. */
  company(workspaceId: string): Promise<InvoiceViewModel['company']> {
    return this.invoiceRender.brandingFor(workspaceId);
  }

  /**
   * One HTML document holding every payslip, a page each. Images go into the
   * stylesheet once (classes `asset-logo`, `asset-stamp`), not into every
   * page; the template only learns whether each one is available.
   */
  async renderDocument(models: PayslipViewModel[], organizationId: string): Promise<string> {
    const { compiled, css, assets } = await this.load();
    const { own, signatory } = payslipExtras(organizationId);
    const shown: Assets = own ? assets : {};
    const flags = { logo: !!shown.logo, stamp: !!shown.stamp };
    const assetCss = (Object.entries(shown) as [keyof Assets, string][])
      .map(([key, uri]) => `.asset-${key} { background-image: url("${uri}"); }`)
      .join('\n');
    const body = models
      .map((vm) => compiled.render({ ...vm, assets: flags, signatory }))
      .join('\n');
    const title = models.length === 1 ? `Payslip ${models[0]!.period.label}` : 'Payslips';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title.replace(/[<>&"]/g, '')}</title>
<style>
@page { size: ${PAYSLIP_PAPER}; }
${css}
${assetCss}
</style>
</head>
<body>
${body}
</body>
</html>`;
  }

  private async load(): Promise<{ compiled: CompiledTemplate; css: string; assets: Assets }> {
    const htmlPath = path.join(this.rootDir, 'template.html');
    const cssPath = path.join(this.rootDir, 'styles.css');
    const assetEntries = Object.entries(ASSET_FILES) as [keyof typeof ASSET_FILES, string][];
    const [htmlStat, cssStat, ...assetStats] = await Promise.all([
      fs.stat(htmlPath),
      fs.stat(cssPath).catch(() => null),
      ...assetEntries.map(([, file]) => fs.stat(path.join(this.rootDir, file)).catch(() => null)),
    ]);
    const stamp = [htmlStat, cssStat, ...assetStats]
      .map((st) => `${st?.mtimeMs ?? 0}:${st?.size ?? 0}`)
      .join('|');
    if (this.cache?.stamp === stamp) return this.cache;
    const [source, css] = await Promise.all([
      fs.readFile(htmlPath, 'utf8'),
      cssStat ? fs.readFile(cssPath, 'utf8') : Promise.resolve(''),
    ]);
    // Inlined as data URIs: Gotenberg renders the HTML with no file access.
    const assets: Assets = {};
    await Promise.all(
      assetEntries.map(async ([key, file], i) => {
        const st = assetStats[i];
        if (!st) return;
        if (st.size > MAX_ASSET_BYTES) {
          this.logger.warn(
            `Payslip image ${file} skipped: ${st.size} bytes (max ${MAX_ASSET_BYTES})`,
          );
          return;
        }
        const bytes = await fs.readFile(path.join(this.rootDir, file));
        assets[key] = `data:image/png;base64,${bytes.toString('base64')}`;
      }),
    );
    this.cache = { stamp, compiled: compileTemplate(source, TEMPLATE_HELPERS), css, assets };
    return this.cache;
  }
}

/** Pure: the template's data for one person's payslip. */
export function buildPayslipViewModel(
  company: InvoiceViewModel['company'],
  run: { year: number; month: number; paidAt: Date | null },
  item: PayslipSource,
  generatedAt: Date,
): PayslipViewModel {
  return {
    company,
    period: {
      label: longPeriodLabel(run.year, run.month),
      year: run.year,
      month: run.month,
    },
    payDate: run.paidAt,
    employee: {
      name: item.employeeName,
      designation: item.designation,
      cnic: item.cnic,
      dateOfJoining: item.dateOfJoining,
      paymentMethod: PAYMENT_METHOD_LABELS[item.paymentMethod],
      isBankTransfer: item.paymentMethod === 'BANK_TRANSFER',
      bankName: item.bankName,
      accountNumber: item.accountNumber,
      accountMasked: maskAccount(item.accountNumber),
    },
    amounts: {
      salary: item.salary,
      bonus: item.bonus,
      commission: item.commission,
      deduction: item.deduction,
      tax: item.tax,
      net: item.net,
      currency: 'PKR',
    },
    bonusNote: item.bonusNote,
    deductionNote: item.deductionNote,
    generatedAt,
  };
}
