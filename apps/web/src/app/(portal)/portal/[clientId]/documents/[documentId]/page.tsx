'use client';

import { use, useState } from 'react';

import { documentGlyph, documentTitle, formatDate, isoDate } from '@/components/portal/format';
import { PortalBackLink, PortalPageHeader } from '@/components/portal/portal-page-header';
import { PortalUnavailable } from '@/components/portal/portal-states';
import { Badge } from '@/components/ui/badge';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { portalErrorStatus, portalHref, usePortalDocument } from '@/hooks/use-portal';
import { usePortalDocumentHtml } from '@/lib/portal/document-html';

export default function PortalDocumentPage({
  params,
}: {
  params: Promise<{ clientId: string; documentId: string }>;
}) {
  const { clientId, documentId } = use(params);
  const doc = usePortalDocument(clientId, documentId);
  const html = usePortalDocumentHtml(doc.data?.content);
  const back = { href: portalHref(clientId, 'documents'), label: 'Documents' };

  if (doc.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6" aria-busy="true">
        <Skeleton className="h-4 w-24" />
        <div className="card space-y-4 px-5 py-8 sm:px-10">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-6 h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      </div>
    );
  }

  if (doc.isError || !doc.data) {
    if (portalErrorStatus(doc.error) === 404) {
      return (
        <PortalUnavailable
          title="This document isn't available"
          description="It may have been removed, or it is no longer shared with you."
          href={back.href}
          linkLabel="Back to documents"
        />
      );
    }
    return (
      <div className="space-y-6">
        <PortalPageHeader back={back} title="Document" />
        <QueryError message="Couldn't load this document." onRetry={() => void doc.refetch()} />
      </div>
    );
  }

  const d = doc.data;
  const glyph = documentGlyph(d.icon);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PortalBackLink href={back.href} label={back.label} />
      <article className="card overflow-hidden">
        {d.coverUrl ? <DocumentCover key={d.coverUrl} src={d.coverUrl} /> : null}
        <div className="px-5 py-8 sm:px-10 sm:py-10">
          <header className="mb-8 space-y-3">
            {glyph ? (
              <span aria-hidden className="block text-4xl leading-none">
                {glyph}
              </span>
            ) : null}
            <h1 className="text-2xl font-semibold text-ink sm:text-3xl">{documentTitle(d.title)}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted">
              <span>
                By <span className="font-medium text-ink">{d.authorName}</span>
              </span>
              <span>
                Updated <time dateTime={isoDate(d.updatedAt)}>{formatDate(d.updatedAt)}</time>
              </span>
              <Badge tone="outline">View only</Badge>
            </div>
          </header>
          {html === null ? (
            <p className="text-sm text-ink-muted">
              This document can&apos;t be displayed here. Ask the person who shared it for a copy.
            </p>
          ) : html === '' ? (
            <p className="text-sm text-ink-muted">This document is empty.</p>
          ) : (
            // Own horizontal scroller: a table whose columns staff resized
            // carries fixed inline widths wider than a phone, and the
            // article's overflow-hidden (kept for the cover) would clip it.
            <div className="overflow-x-auto">
              <div
                className="prose max-w-none"
                // Tiptap's `generateHTML` serializes only schema-permitted nodes;
                // no script tags or event handlers survive that round trip.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

/** The cover banner, dropped quietly if the image cannot load. */
function DocumentCover({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // Covers can live on any storage host; next/image would need each one
    // allowlisted up front. Decorative, so the alt text is empty.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      className="block h-40 w-full object-cover sm:h-52"
    />
  );
}
