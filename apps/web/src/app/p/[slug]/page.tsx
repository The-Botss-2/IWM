import { generateHTML } from '@tiptap/html';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@botss/api-client';
import type { PublicDocument } from '@botss/shared-types';

import { baseExtensions } from '@/components/editor/extensions-base';
import { createPublicServerApi } from '@/lib/server-api';

interface PageProps {
  params: Promise<{ slug: string }>;
}

// Always render fresh - the public link reflects whatever the author saved
// last, and a stale ISR cache would surface old text or even an already-
// revoked link.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The shared document, or null when the link doesn't exist / was revoked. */
async function fetchPublicDocument(slug: string): Promise<PublicDocument | null> {
  try {
    return await createPublicServerApi().documents.public(slug);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await fetchPublicDocument(slug).catch(() => null);
  if (!doc) return { title: 'Document not found' };
  return {
    title: `${doc.title} · ${doc.workspaceName}`,
    description: `Shared document by ${doc.authorName}`,
    robots: { index: false, follow: false },
  };
}

export default async function PublicDocumentPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = await fetchPublicDocument(slug);
  if (!doc) notFound();

  const html =
    doc.content && typeof doc.content === 'object'
      ? generateHTML(
          doc.content as Parameters<typeof generateHTML>[0],
          baseExtensions({ includeImage: true, placeholder: '' }),
        )
      : '';

  const updatedDate = new Date(doc.updatedAt);
  const updatedAbsolute = updatedDate.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    // Paper-feel layout: light page background with a white "sheet" centered
    // on top, subtle shadow, generous padding. Reads as a document rather
    // than a marketing page.
    <div className="min-h-[calc(100vh-4rem)] bg-bg-subtle">
      <article className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <div className="rounded-lg border border-line bg-white px-6 py-10 shadow-sm sm:px-12 sm:py-14">
          <header className="mb-8">
            {doc.workspaceName ? (
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-disabled">
                {doc.workspaceName}
              </p>
            ) : null}
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              {doc.title}
            </h1>
            <p className="mt-3 text-sm text-ink-muted">
              By <span className="font-medium text-ink">{doc.authorName}</span>
              <span className="mx-1.5 text-line-strong">·</span>
              <span>Last updated {updatedAbsolute}</span>
            </p>
          </header>

          <div
            className="prose prose-slate max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-pre:bg-ink prose-pre:text-slate-100 prose-pre:text-xs prose-pre:rounded-md prose-code:before:content-none prose-code:after:content-none prose-table:border prose-th:border prose-td:border prose-th:p-2 prose-td:p-2 prose-img:rounded-md prose-a:text-brand-700 prose-a:no-underline hover:prose-a:underline prose-blockquote:border-brand-purple/40"
            // Tiptap's `generateHTML` serializes only schema-permitted nodes;
            // no script tags or event handlers can survive that round-trip.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>

        <footer className="mt-6 flex items-center justify-center text-xs text-ink-disabled">
          <Link
            href="/"
            className="inline-flex items-center gap-1 rounded px-2 py-1 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
          >
            Made with The Botss
          </Link>
        </footer>
      </article>
    </div>
  );
}
