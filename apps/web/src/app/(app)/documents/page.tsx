'use client';

import { Globe, Lock, PenLine, Plus, Search, Share2, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { DocumentViewerPermission, DocumentWithCreator } from '@botss/shared-types';

import { ShareDialog } from '@/components/documents/share-dialog';
import { RequestSignaturesDialog } from '@/components/signatures/request-signatures-dialog';
import { SignatureStatusCard } from '@/components/signatures/signature-status-card';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/lib/ability';
import { useDebouncedValue } from '@/hooks/use-debounced';
import {
  useCreateDocument,
  useDeleteDocument,
  useDocuments,
  useUpdateDocument,
} from '@/hooks/use-documents';
import { useSignatureViewer } from '@/hooks/use-signatures';

// Tiptap + extensions are the bulk of this route's JS; load them only once a
// document is actually selected.
const DocumentEditor = dynamic(
  () => import('@/components/editor/editor').then((m) => ({ default: m.DocumentEditor })),
  { ssr: false, loading: () => <Skeleton className="h-96 w-full rounded-xl" /> },
);

export default function DocumentsPage() {
  const [search, setSearch] = useState('');
  // Server-side search: the /documents list endpoint filters by title.
  const debouncedSearch = useDebouncedValue(search, 250);
  const documents = useDocuments({
    pageSize: 50,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  });
  const create = useCreateDocument();
  const update = useUpdateDocument();
  const del = useDeleteDocument();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Deep link: /documents?doc=<id> from search results opens that document.
  useEffect(() => {
    const doc = new URLSearchParams(window.location.search).get('doc');
    if (doc) setSelectedId(doc);
  }, []);

  function deleteDoc(id: string, title: string): void {
    if (!window.confirm(`Delete "${title || 'Untitled'}"? This cannot be undone.`)) {
      return;
    }
    del.mutate(id, {
      onSuccess: () => {
        if (selectedId === id) setSelectedId(null);
      },
    });
  }
  const [shareOpen, setShareOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const signatureViewer = useSignatureViewer();

  const selected: DocumentWithCreator | null =
    documents.data?.items.find((d) => d.id === selectedId) ?? null;
  const viewerPerm: DocumentViewerPermission = selected?.viewerPermission ?? 'OWNER';
  const canEdit = viewerPerm !== 'READ';

  return (
    <div className="mx-auto grid h-auto min-h-[calc(var(--app-content-h,calc(100vh-4rem))-3rem)] max-w-7xl grid-cols-1 gap-4 px-4 py-6 sm:px-6 md:h-[calc(var(--app-content-h,calc(100vh-4rem))-3rem)] md:min-h-0 md:grid-cols-[260px_1fr] lg:px-8">
      <aside className="space-y-2 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Documents</h2>
          <Can I="create" a="Document">
            <button
              className="btn-ghost px-2"
              onClick={() =>
                create.mutate(
                  {
                    title: 'Untitled',
                    visibility: 'WORKSPACE',
                    content: { type: 'doc', content: [] },
                  },
                  {
                    onSuccess: (newDoc) => {
                      setSelectedId(newDoc.id);
                    },
                  },
                )
              }
            >
              <Plus className="h-4 w-4" />
            </button>
          </Can>
        </div>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            className="input h-9 w-full pl-8 text-sm"
          />
        </div>
        {documents.isLoading ? (
          <div className="flex justify-center">
            <Loader size="sm" label="Loading" />
          </div>
        ) : documents.isError ? (
          <QueryError onRetry={() => void documents.refetch()} />
        ) : documents.data?.items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-ink-muted">
            {debouncedSearch.trim() ? 'No documents match.' : 'No documents yet.'}
          </div>
        ) : (
          <ul className="space-y-1">
            {documents.data?.items.map((d) => (
              <li key={d.id} className="group relative">
                <button
                  onClick={() => setSelectedId(d.id)}
                  className={`w-full rounded-md px-3 py-2 pr-9 text-left text-sm ${
                    selectedId === d.id
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-ink hover:bg-bg-subtle'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{d.title}</span>
                    {d.publicSlug ? (
                      <Globe className="h-3 w-3 shrink-0 text-brand-600" aria-label="Shared publicly" />
                    ) : null}
                  </div>
                  <div className="text-[11px] text-ink-muted">{d.visibility}</div>
                </button>
                <Can I="delete" a="Document">
                  <button
                    type="button"
                    aria-label={`Delete ${d.title || 'Untitled'}`}
                    onClick={() => deleteDoc(d.id, d.title)}
                    disabled={del.isPending}
                    className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-ink-muted opacity-0 transition hover:bg-tint-error hover:text-state-error focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </Can>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="space-y-3 overflow-y-auto">
        {selected ? (
          <>
            {!canEdit ? (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-brand-orange/30 bg-tint-warning px-3 py-2 text-sm text-brand-orange"
              >
                <Lock className="h-4 w-4" aria-hidden />
                Read only - you don&apos;t have edit access on this document.
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <input
                key={selected.id}
                className="input flex-1 text-lg font-semibold"
                defaultValue={selected.title}
                readOnly={!canEdit}
                onBlur={(e) => {
                  if (!canEdit) return;
                  const newTitle = e.target.value.trim() || 'Untitled';
                  e.target.value = newTitle;
                  if (newTitle !== selected.title) {
                    update.mutate({ id: selected.id, input: { title: newTitle } });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    e.currentTarget.value = selected.title;
                    e.currentTarget.blur();
                  }
                }}
              />
              {canEdit ? (
                <Can I="create" a="SignatureRequest">
                  <button
                    type="button"
                    onClick={() => setSignOpen(true)}
                    className="btn-secondary shrink-0"
                    title="Request signatures"
                  >
                    <PenLine className="h-4 w-4" />
                    <span className="hidden sm:inline">Request signatures</span>
                  </button>
                </Can>
              ) : null}
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                className="btn-secondary shrink-0"
              >
                <Share2 className="h-4 w-4" />
                {selected.publicSlug ? 'Shared' : 'Share'}
                {selected.accessGrantCount && selected.accessGrantCount > 0 ? (
                  <span className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand-50 px-1 text-[10px] font-semibold text-brand-700">
                    {selected.accessGrantCount}
                  </span>
                ) : null}
              </button>
            </div>
            <SignatureStatusCard
              documentId={selected.id}
              currentUserId={signatureViewer.userId}
              isWorkspaceAdmin={signatureViewer.isWorkspaceAdmin}
            />
            <DocumentEditor
              key={selected.id}
              value={selected.content}
              editable={canEdit}
              onChange={(content) => {
                if (!canEdit) return;
                update.mutate({ id: selected.id, input: { content } });
              }}
            />
            <ShareDialog doc={selected} open={shareOpen} onOpenChange={setShareOpen} />
            <RequestSignaturesDialog
              documentId={selected.id}
              documentTitle={selected.title}
              open={signOpen}
              onOpenChange={setSignOpen}
            />
          </>
        ) : (
          <div className="card p-10 text-center text-sm text-ink-muted">
            Select a document on the left, or create a new one.
          </div>
        )}
      </section>
    </div>
  );
}
