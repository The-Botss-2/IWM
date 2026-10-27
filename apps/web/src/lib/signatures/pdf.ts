'use client';

/**
 * pdf.js loader for the signature views. Loaded lazily (only the signing and
 * request screens need it) and from the LEGACY build, which avoids syntax and
 * APIs such as `Promise.withResolvers` that older Android WebViews inside the
 * mobile app do not have.
 *
 * The worker is created with `new Worker(new URL(..., import.meta.url))`,
 * the pattern webpack recognises and bundles as a same-origin chunk, so it
 * passes the `worker-src 'self' blob:` CSP without a CDN.
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

let loader: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!loader) {
    loader = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      if (!pdfjs.GlobalWorkerOptions.workerPort) {
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(
          new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url),
          { type: 'module' },
        );
      }
      return pdfjs;
    });
    loader.catch(() => {
      loader = null;
    });
  }
  return loader;
}

/** Parse PDF bytes. The caller owns the result and should `destroy()` it. */
export async function openPdf(bytes: ArrayBuffer): Promise<PdfDocument> {
  const pdfjs = await loadPdfJs();
  // pdf.js transfers the buffer to its worker; give it a copy so the caller's
  // bytes stay usable (e.g. for a later download).
  const data = new Uint8Array(bytes.slice(0));
  return pdfjs.getDocument({
    data,
    // No font or CMap fetching from a CDN; the CSP would block it anyway.
    disableFontFace: false,
    isEvalSupported: false,
  }).promise;
}

/**
 * Render one page into a canvas at the given CSS width. The backing store is
 * scaled by devicePixelRatio (capped at 2) so text stays crisp on phones. The
 * viewport already applies the page's /Rotate and crop box, which is the same
 * "page as displayed" space the API uses for field fractions.
 *
 * Returns a cancel function: re-rendering a canvas while a previous render is
 * still drawing into it makes pdf.js throw.
 */
export function renderPage(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): { done: Promise<void>; cancel: () => void } {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const viewport = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${viewport.height / dpr}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { done: Promise.reject(new Error('Canvas is not available')), cancel: () => {} };
  const task = page.render({ canvasContext: ctx, viewport });
  return {
    done: task.promise.catch((err: unknown) => {
      // A cancelled render rejects; that is expected, not an error.
      if ((err as { name?: string })?.name === 'RenderingCancelledException') return;
      throw err;
    }),
    cancel: () => task.cancel(),
  };
}

/** Displayed height / width of a page (rotation applied). */
export function pageAspect(page: PdfPage): number {
  const v = page.getViewport({ scale: 1 });
  return v.height / v.width;
}
