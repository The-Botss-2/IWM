'use client';

import { ChevronRight, FileText } from 'lucide-react';
import Link from 'next/link';
import { use } from 'react';

import {
  documentGlyph,
  documentTitle,
  formatDate,
  isoDate,
} from '@/components/portal/format';
import { usePortalClient } from '@/components/portal/portal-context';
import { PortalPageHeader } from '@/components/portal/portal-page-header';
import { PortalEmpty } from '@/components/portal/portal-states';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { portalDocumentHref, usePortalDocuments } from '@/hooks/use-portal';
import { relativeTime } from '@/lib/time';

export default function PortalDocumentsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const client = usePortalClient(clientId);
  const documents = usePortalDocuments(clientId);

  if (!client) return null;
  const items = documents.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PortalPageHeader
        title="Documents"
        description={`Documents ${client.agency.name} has shared with you. They are view only.`}
      />
      {documents.isLoading ? (
        <div className="card divide-y divide-line" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : documents.isError ? (
        <QueryError
          message="Couldn't load documents."
          onRetry={() => void documents.refetch()}
        />
      ) : items.length === 0 ? (
        <PortalEmpty
          icon={FileText}
          title="Nothing has been shared with you yet"
          description={`When ${client.agency.name} shares a document with you or your company, it appears here.`}
        />
      ) : (
        <ul className="card divide-y divide-line overflow-hidden">
          {items.map((doc) => {
            const glyph = documentGlyph(doc.icon);
            return (
              <li key={doc.id}>
                <Link
                  href={portalDocumentHref(client.id, doc.id)}
                  className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-purple/50 sm:px-5"
                >
                  <span
                    aria-hidden
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-bg-subtle text-lg text-ink-muted"
                  >
                    {glyph ?? <FileText className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {documentTitle(doc.title)}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      Updated{' '}
                      <time dateTime={isoDate(doc.updatedAt)} title={formatDate(doc.updatedAt)}>
                        {relativeTime(doc.updatedAt)}
                      </time>
                      <span aria-hidden> · </span>
                      <span className="sr-only">, </span>
                      {doc.sharedWith === 'COMPANY' ? 'Shared with your company' : 'Shared with you'}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
