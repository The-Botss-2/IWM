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
    <div className="bg-bg-subtle min-h-[calc(100vh-4rem)]">
      <article className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <div className="border-line rounded-lg border bg-white px-6 py-10 shadow-sm sm:px-12 sm:py-14">
          <header className="mb-8">
            {doc.workspaceName ? (
              <p className="text-ink-disabled text-[11px] font-medium uppercase tracking-[0.18em]">
                {doc.workspaceName}
              </p>
            ) : null}
            <h1 className="text-ink mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              {doc.title}
            </h1>
            <p className="text-ink-muted mt-3 text-sm">
              By <span className="text-ink font-medium">{doc.authorName}</span>
              <span className="text-line-strong mx-1.5">·</span>
              <span>Last updated {updatedAbsolute}</span>
            </p>
          </header>

          <div
            className="prose prose-slate prose-headings:font-semibold prose-headings:tracking-tight prose-pre:bg-ink prose-pre:text-slate-100 prose-pre:text-xs prose-pre:rounded-md prose-code:before:content-none prose-code:after:content-none prose-table:border prose-th:border prose-td:border prose-th:p-2 prose-td:p-2 prose-img:rounded-md prose-a:text-brand-700 prose-a:no-underline hover:prose-a:underline prose-blockquote:border-brand-purple/40 max-w-none"
            // Tiptap's `generateHTML` serializes only schema-permitted nodes;
            // no script tags or event handlers can survive that round-trip.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>

        <footer className="text-ink-disabled mt-6 flex items-center justify-center text-xs">
          <Link
            href="/"
            className="hover:text-ink focus-visible:shadow-focus inline-flex items-center gap-1 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2"
          >
            Made with The Botss
          </Link>
        </footer>
      </article>
    </div>
  );
}
