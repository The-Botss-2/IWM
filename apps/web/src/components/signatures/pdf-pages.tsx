'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Loader } from '@/components/ui/loader';
import { pageAspect, renderPage, type PdfDocument, type PdfPage } from '@/lib/signatures/pdf';
import { cn } from '@/lib/utils';

/**
 * Every page of a PDF, stacked, each with an absolutely positioned overlay the
 * caller fills (signature fields). The overlay covers exactly the rendered
 * page, so field fractions map straight to CSS percentages.
 */
export function PdfPages({
  doc,
  overlay,
  onPageClick,
  className,
}: {
  doc: PdfDocument;
  overlay?: (page: number) => ReactNode;
  /** Click on empty page area, in page fractions. */
  onPageClick?: (page: number, point: { x: number; y: number }) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <div ref={containerRef} className={cn('w-full space-y-4', className)}>
      {width > 0
        ? pages.map((n) => (
            <PdfPageView
              key={n}
              doc={doc}
              pageNumber={n}
              width={width}
              overlay={overlay?.(n)}
              onPageClick={onPageClick}
            />
          ))
        : null}
    </div>
  );
}

function PdfPageView({
  doc,
  pageNumber,
  width,
  overlay,
  onPageClick,
}: {
  doc: PdfDocument;
  pageNumber: number;
  width: number;
  overlay?: ReactNode;
  onPageClick?: (page: number, point: { x: number; y: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<PdfPage | null>(null);
  const [aspect, setAspect] = useState(1.414);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void doc.getPage(pageNumber).then((p) => {
      if (cancelled) return;
      setPage(p);
      setAspect(pageAspect(p));
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  useEffect(() => {
    if (!page || !canvasRef.current || width <= 0) return;
    const job = renderPage(page, canvasRef.current, width);
    void job.done.then(() => setRendered(true)).catch(() => setRendered(true));
    return () => job.cancel();
  }, [page, width]);

  return (
    <div
      className="relative mx-auto overflow-hidden rounded-md bg-white shadow-soft ring-1 ring-line"
      style={{ width, height: Math.round(width * aspect) }}
      data-page={pageNumber}
      aria-label={`Page ${pageNumber} of ${doc.numPages}`}
      role="group"
      onClick={(e) => {
        if (!onPageClick || e.target !== e.currentTarget.querySelector('[data-page-hit]')) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onPageClick(pageNumber, {
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        });
      }}
    >
      <canvas ref={canvasRef} className="block" aria-hidden />
      {!rendered ? (
        <div className="absolute inset-0 grid place-items-center">
          <Loader size="sm" label={`Loading page ${pageNumber}`} />
        </div>
      ) : null}
      {/* Hit area for "click to place"; fields sit above it. */}
      <div data-page-hit className={cn('absolute inset-0', onPageClick ? 'cursor-crosshair' : '')} />
      <div className="pointer-events-none absolute inset-0">{overlay}</div>
      <span className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white">
        {pageNumber} / {doc.numPages}
      </span>
    </div>
  );
}
