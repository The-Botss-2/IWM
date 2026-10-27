import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { InvoiceTemplate } from '@botss/shared-types';

import { compileTemplate, type CompiledTemplate, SafeString } from './template-engine';

/** The template that ships with the app and is used when nothing else is set. */
export const DEFAULT_TEMPLATE_KEY = 'default';

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface LoadedTemplate {
  meta: InvoiceTemplate & { marginsMm: { top: number; right: number; bottom: number; left: number } };
  compiled: CompiledTemplate;
  /** Template CSS with `url(assets/...)` references inlined as data URIs. */
  css: string;
}

interface TemplateMetaFile {
  name?: unknown;
  description?: unknown;
  paper?: unknown;
  marginsMm?: { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown };
}

/**
 * Loads HTML invoice templates from disk.
 *
 * Layout (see "Invoice and payslip templates" in the README):
 *   invoice-templates/<key>/template.html   the markup, Handlebars-style tags
 *   invoice-templates/<key>/styles.css      optional
 *   invoice-templates/<key>/meta.json       name, description, paper, margins
 *   invoice-templates/<key>/assets/*        optional images and fonts
 *
 * Assets referenced as `assets/...` from the HTML or CSS are inlined as data
 * URIs, so the PDF renderer never needs network or file access. Compiled
 * templates are cached and reloaded when any of their files change, so a
 * deployed template edit takes effect without a restart.
 */
@Injectable()
export class InvoiceTemplatesService {
  private readonly logger = new Logger(InvoiceTemplatesService.name);
  private readonly cache = new Map<string, { stamp: string; template: LoadedTemplate }>();

  /** Resolved once: env override, else the folder next to the API build. */
  readonly rootDir =
    process.env.INVOICE_TEMPLATES_DIR?.trim() ||
    // dist/invoices/*.js and src/invoices/*.ts both sit two levels below apps/api.
    path.resolve(__dirname, '..', '..', 'invoice-templates');

  async list(): Promise<InvoiceTemplate[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch {
      this.logger.warn(`Invoice templates folder not found: ${this.rootDir}`);
      return [];
    }
    const templates: InvoiceTemplate[] = [];
    for (const key of entries.sort()) {
      if (!KEY_PATTERN.test(key)) continue;
      try {
        await fs.access(path.join(this.rootDir, key, 'template.html'));
        const { meta } = await this.readMeta(key);
        templates.push({ key, name: meta.name, description: meta.description, paper: meta.paper });
      } catch {
        // Not a template folder (no template.html). Skip quietly.
      }
    }
    return templates;
  }

  async load(key: string): Promise<LoadedTemplate> {
    if (!KEY_PATTERN.test(key)) {
      throw new NotFoundException({ title: 'Invoice template not found', status: 404 });
    }
    const dir = path.join(this.rootDir, key);
    const files = ['template.html', 'styles.css', 'meta.json'].map((f) => path.join(dir, f));
    const stamps = await Promise.all(
      files.map((f) =>
        fs
          .stat(f)
          .then((s) => `${s.mtimeMs}:${s.size}`)
          .catch(() => 'none'),
      ),
    );
    if (stamps[0] === 'none') {
      throw new NotFoundException({
        title: 'Invoice template not found',
        status: 404,
        detail: `No template.html in invoice-templates/${key}.`,
      });
    }
    const stamp = stamps.join('|');
    const cached = this.cache.get(key);
    if (cached && cached.stamp === stamp) return cached.template;

    const [html, cssRaw] = await Promise.all([
      fs.readFile(files[0]!, 'utf8'),
      fs.readFile(files[1]!, 'utf8').catch(() => ''),
    ]);
    const { meta } = await this.readMeta(key);
    const htmlWithAssets = await this.inlineAssets(dir, html);
    const css = await this.inlineAssets(dir, cssRaw);
    const compiled = compileTemplate(htmlWithAssets, TEMPLATE_HELPERS);
    const template: LoadedTemplate = { meta: { key, ...meta }, compiled, css };
    this.cache.set(key, { stamp, template });
    return template;
  }

  private async readMeta(key: string): Promise<{ meta: Omit<LoadedTemplate['meta'], 'key'> }> {
    let parsed: TemplateMetaFile = {};
    try {
      parsed = JSON.parse(
        await fs.readFile(path.join(this.rootDir, key, 'meta.json'), 'utf8'),
      ) as TemplateMetaFile;
    } catch {
      parsed = {};
    }
    const num = (v: unknown, d: number) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 60 ? v : d;
    return {
      meta: {
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : key,
        description: typeof parsed.description === 'string' ? parsed.description : null,
        paper: parsed.paper === 'Letter' ? 'Letter' : 'A4',
        marginsMm: {
          top: num(parsed.marginsMm?.top, 15),
          right: num(parsed.marginsMm?.right, 15),
          bottom: num(parsed.marginsMm?.bottom, 15),
          left: num(parsed.marginsMm?.left, 15),
        },
      },
    };
  }

  /** Replace `assets/<file>` references with data URIs. */
  private async inlineAssets(dir: string, source: string): Promise<string> {
    const refs = new Set<string>();
    const re = /(["'(])\s*(assets\/[A-Za-z0-9._\-/]+)\s*(?=["')])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) refs.add(m[2]!);
    let out = source;
    for (const ref of refs) {
      const abs = path.resolve(dir, ref);
      // Never follow a reference out of the template's own folder.
      if (!abs.startsWith(path.resolve(dir) + path.sep)) continue;
      const mime = ASSET_MIME[path.extname(abs).toLowerCase()];
      if (!mime) continue;
      try {
        const bytes = await fs.readFile(abs);
        if (bytes.byteLength > MAX_ASSET_BYTES) {
          this.logger.warn(`Invoice template asset too large, skipped: ${ref}`);
          continue;
        }
        out = out.split(ref).join(`data:${mime};base64,${bytes.toString('base64')}`);
      } catch {
        this.logger.warn(`Invoice template asset missing: ${ref}`);
      }
    }
    return out;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/** Helpers available inside every template. Documented in the README. */
export const TEMPLATE_HELPERS = {
  /** {{money invoice.total invoice.currency}} -> "$1,250.00" */
  money: (value: unknown, currency: unknown) => {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
    try {
      // Pinned to 2dp like the stored amounts: ICU 78 gives PKR 0 digits and
      // would round "1,250.50" to "PKR 1,251".
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `${code} ${n.toFixed(2)}`;
    }
  },
  /**
   * {{amount payslip.net "PKR"}} -> "PKR 25,000": whole amounts without
   * decimals, "PKR 25,000.50" when there are paisa (never rounded away).
   */
  amount: (value: unknown, currency: unknown) => {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
    const digits = Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2;
    const text = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    return `${code} ${text}`;
  },
  /** {{number line.quantity 2}} -> "1.50" */
  number: (value: unknown, decimals: unknown) => {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    const d = typeof decimals === 'number' ? decimals : 2;
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.max(0, Math.min(6, d)),
    }).format(n);
  },
  /** {{percent line.taxRate}} -> "17%" */
  percent: (value: unknown) => {
    const n = toNumber(value);
    return Number.isFinite(n) ? `${Number(n.toFixed(2))}%` : '';
  },
  /** {{date invoice.issuedAt}} -> "11 Sep 2026"; formats: "short" (default), "long", "iso" */
  date: (value: unknown, format: unknown) => {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    if (format === 'iso') return d.toISOString().slice(0, 10);
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: format === 'long' ? 'long' : 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(d);
  },
  /** {{nl2br invoice.notes}} keeps line breaks from multi-line fields. */
  nl2br: (value: unknown) => {
    if (value === null || value === undefined) return '';
    const escaped = String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    return new SafeString(escaped.replace(/\r?\n/g, '<br>'));
  },
  upper: (value: unknown) => (value === null || value === undefined ? '' : String(value).toUpperCase()),
  lower: (value: unknown) => (value === null || value === undefined ? '' : String(value).toLowerCase()),
  /** {{default client.email "No email"}} */
  default: (value: unknown, fallback: unknown) =>
    value === null || value === undefined || value === '' ? fallback : value,
  /** {{#if (eq invoice.status "PAID")}} */
  eq: (a: unknown, b: unknown) => a === b,
  ne: (a: unknown, b: unknown) => a !== b,
  gt: (a: unknown, b: unknown) => toNumber(a) > toNumber(b),
  or: (...args: unknown[]) => args.some(Boolean),
  and: (...args: unknown[]) => args.every(Boolean),
};
