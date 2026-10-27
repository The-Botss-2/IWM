import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface PdfRenderOptions {
  paper: 'A4' | 'Letter';
  marginsMm: { top: number; right: number; bottom: number; left: number };
}

const PAPER_INCHES: Record<PdfRenderOptions['paper'], { width: number; height: number }> = {
  A4: { width: 8.27, height: 11.69 },
  Letter: { width: 8.5, height: 11 },
};

const MM_PER_INCH = 25.4;

/**
 * HTML to PDF through Gotenberg (headless Chromium in its own container, see
 * docker-compose.yml). The API sends one self-contained HTML document with
 * every asset inlined; Gotenberg runs with JavaScript disabled and no network,
 * so a template can neither run script nor fetch anything while rendering.
 *
 * Env: GOTENBERG_URL, e.g. http://127.0.0.1:3100
 */
@Injectable()
export class GotenbergClient {
  private readonly logger = new Logger(GotenbergClient.name);

  get configured(): boolean {
    return Boolean(process.env.GOTENBERG_URL?.trim());
  }

  async htmlToPdf(html: string, options: PdfRenderOptions): Promise<Buffer> {
    const base = process.env.GOTENBERG_URL?.trim().replace(/\/+$/, '');
    if (!base) {
      throw new ServiceUnavailableException({
        title: 'PDF rendering is not configured',
        status: 503,
        detail: 'Set GOTENBERG_URL and start the gotenberg container.',
        code: 'pdf-renderer-missing',
      });
    }
    const paper = PAPER_INCHES[options.paper];
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('paperWidth', String(paper.width));
    form.append('paperHeight', String(paper.height));
    form.append('marginTop', String(options.marginsMm.top / MM_PER_INCH));
    form.append('marginRight', String(options.marginsMm.right / MM_PER_INCH));
    form.append('marginBottom', String(options.marginsMm.bottom / MM_PER_INCH));
    form.append('marginLeft', String(options.marginsMm.left / MM_PER_INCH));
    form.append('printBackground', 'true');
    form.append('preferCssPageSize', 'false');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${base}/forms/chromium/convert/html`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.error(`Gotenberg returned ${res.status}: ${text.slice(0, 300)}`);
        throw new ServiceUnavailableException({
          title: 'PDF rendering failed',
          status: 503,
          detail: `The PDF renderer answered ${res.status}.`,
        });
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Gotenberg request failed: ${(err as Error)?.message ?? 'unknown'}`);
      throw new ServiceUnavailableException({
        title: 'PDF renderer unreachable',
        status: 503,
        detail: 'Check that the gotenberg container is running.',
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
