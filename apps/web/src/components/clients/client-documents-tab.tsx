'use client';

import { ExternalLink, FilePlus2, FileSignature, FileText, Share2, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { ClientDocument, ClientDocumentLink } from '@botss/shared-types';

import { RequestSignaturesDialog } from '@/components/signatures/request-signatures-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import {
  useClientDocuments,
  useCreateClientDocument,
  useSetClientDocumentShare,
  validateDocumentTitle,
  type CreateClientDocumentResult,
} from '@/hooks/use-client-documents';
import { Can, useAbility } from '@/lib/ability';
import { absoluteTime, relativeTime } from '@/lib/time';

const LINK_LABEL: Record<ClientDocumentLink, string> = {
  FILED: 'Filed',
  PROJECT: 'Project',
  SHARED: 'Shared',
};

const LINK_HINT: Record<ClientDocumentLink, string> = {
  FILED: 'Filed under this client',
  PROJECT: "In one of this client's projects",
  SHARED: 'Shared with this client or someone there',
};

const docHref = (id: string) => `/documents?doc=${encodeURIComponent(id)}`;

export function ClientDocumentsTab({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const docs = useClientDocuments(clientId);
  const [creating, setCreating] = useState(false);
  const [signing, setSigning] = useState<ClientDocument | null>(null);
  const items = docs.data?.items ?? [];

  return (
    <section className="space-y-4" aria-labelledby="client-docs-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="client-docs-heading" className="text-ink text-base font-semibold">
            Documents
          </h2>
          <p className="text-ink-muted mt-0.5 text-sm">
            Filed under {clientName}, in its projects, or shared with it.
          </p>
        </div>
        <Can I="create" a="Document">
          <Button size="sm" onClick={() => setCreating(true)}>
            <FilePlus2 className="h-4 w-4" aria-hidden />
            New document
          </Button>
        </Can>
      </div>

      {docs.isLoading ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : docs.isError ? (
        <QueryError message="Couldn't load documents." onRetry={() => void docs.refetch()} />
      ) : items.length === 0 ? (
        <div className="border-line rounded-lg border border-dashed bg-white p-10 text-center">
          <p className="text-ink text-sm font-medium">No documents for this client yet.</p>
          <p className="text-ink-muted mt-1 text-sm">
            New documents made here are filed under {clientName} and stay internal until you share
            them.
          </p>
        </div>
      ) : (
        <>
          <ul className="divide-line border-line divide-y rounded-lg border bg-white">
            {items.map((d) => (
              <DocumentRow
                key={d.id}
                doc={d}
                clientId={clientId}
                clientName={clientName}
                onRequestSignature={() => setSigning(d)}
              />
            ))}
          </ul>
          {docs.data?.hasMore ? (
            <p className="text-ink-muted text-xs">
              Showing the most recent {items.length} documents. Search the{' '}
              <Link href="/documents" className="underline">
                Documents page
              </Link>{' '}
              for older ones.
            </p>
          ) : null}
        </>
      )}

      <NewClientDocumentDialog
        open={creating}
        onOpenChange={setCreating}
        clientId={clientId}
        clientName={clientName}
      />
      {signing ? (
        <RequestSignaturesDialog
          documentId={signing.id}
          documentTitle={signing.title}
          open
          onOpenChange={(o) => {
            if (!o) setSigning(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DocumentRow({
  doc: d,
  clientId,
  clientName,
  onRequestSignature,
}: {
  doc: ClientDocument;
  clientId: string;
  clientName: string;
  onRequestSignature: () => void;
}) {
  const share = useSetClientDocumentShare(clientId);
  const canRequestSignature =
    useAbility().can('create', 'SignatureRequest') && d.viewerPermission !== 'READ';
  const [confirmUnshare, setConfirmUnshare] = useState(false);
  const projectName = d.project ? (d.project.name ?? 'Private project') : null;

  return (
    <li className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className="bg-bg-subtle flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base"
          aria-hidden
        >
          {d.icon ? d.icon : <FileText className="text-ink-muted h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={docHref(d.id)}
              className="text-ink focus-visible:shadow-focus min-w-0 truncate rounded text-sm font-medium hover:underline focus-visible:outline-none"
            >
              {d.title || 'Untitled'}
            </Link>
            <Tooltip content={LINK_HINT[d.link]}>
              <span>
                <Badge tone="outline">{LINK_LABEL[d.link]}</Badge>
              </span>
            </Tooltip>
            {d.sharedWithClient ? (
              <Badge tone="info">
                <Share2 className="h-3 w-3" aria-hidden />
                Shared with {clientName}
              </Badge>
            ) : d.sharedWithPeopleCount > 0 ? (
              <Badge tone="neutral">
                <Users className="h-3 w-3" aria-hidden />
                Shared with {d.sharedWithPeopleCount}{' '}
                {d.sharedWithPeopleCount === 1 ? 'person' : 'people'}
              </Badge>
            ) : (
              <Badge tone="neutral">Internal</Badge>
            )}
          </div>
          <p className="text-ink-muted mt-0.5 flex flex-wrap gap-x-2 text-xs">
            {projectName ? <span className="truncate">{projectName}</span> : null}
            <Tooltip content={absoluteTime(d.updatedAt)}>
              <span>Updated {relativeTime(d.updatedAt)}</span>
            </Tooltip>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-11 sm:pl-0">
        {d.canManageShare ? (
          d.sharedWithClient ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmUnshare(true)}
              disabled={share.isPending}
            >
              Stop sharing
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => share.mutate({ docId: d.id, shared: true })}
              disabled={share.isPending}
            >
              <Share2 className="h-3.5 w-3.5" aria-hidden />
              Share with client
            </Button>
          )
        ) : null}
        {canRequestSignature ? (
          <Button variant="ghost" size="sm" onClick={onRequestSignature}>
            <FileSignature className="h-3.5 w-3.5" aria-hidden />
            Request signature
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm">
          <Link href={docHref(d.id)}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open
          </Link>
        </Button>
      </div>

      <ConfirmDialog
        open={confirmUnshare}
        onOpenChange={setConfirmUnshare}
        title={`Stop sharing with ${clientName}?`}
        description="People at this client lose access through the portal. Anyone you shared it with personally keeps access."
        confirmLabel="Stop sharing"
        cancelLabel="Keep sharing"
        variant="destructive"
        pending={share.isPending}
        onConfirm={() =>
          share
            .mutateAsync({ docId: d.id, shared: false })
            .then(() => setConfirmUnshare(false))
            // useSetClientDocumentShare's onError already toasted.
            .catch(() => undefined)
        }
      />
    </li>
  );
}

function NewClientDocumentDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  clientName: string;
}) {
  const create = useCreateClientDocument(clientId, clientName);
  const [title, setTitle] = useState('');
  const [shareNow, setShareNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateClientDocumentResult | null>(null);

  const reset = () => {
    setTitle('');
    setShareNow(false);
    setError(null);
    setCreated(null);
  };

  const close = (next: boolean) => {
    if (!next && create.isPending) return;
    onOpenChange(next);
    if (!next) reset();
  };

  const submit = () => {
    const problem = validateDocumentTitle(title);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    create.mutate({ title, shareNow }, { onSuccess: setCreated });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Document created</DialogTitle>
              <DialogDescription>
                {created.shared
                  ? `"${created.document.title}" is filed under ${clientName} and shared with them.`
                  : created.shareError
                    ? `"${created.document.title}" is filed under ${clientName}, but sharing failed. It is internal for now.`
                    : `"${created.document.title}" is filed under ${clientName}. Only your team can see it.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => close(false)}>
                Done
              </Button>
              <Button asChild>
                <Link href={docHref(created.document.id)}>Open document</Link>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>New document</DialogTitle>
              <DialogDescription>Filed under {clientName}.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="client-doc-title">Title</Label>
              <Input
                id="client-doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Statement of work"
                autoFocus
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'client-doc-title-error' : undefined}
              />
              {error ? (
                <p id="client-doc-title-error" className="text-state-error text-xs">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="client-doc-share"
                checked={shareNow}
                onCheckedChange={(v) => setShareNow(v === true)}
                className="mt-0.5"
              />
              <div>
                <Label htmlFor="client-doc-share">Share with {clientName} now</Label>
                <p className="text-ink-muted text-xs">
                  Everyone with portal access at {clientName} can read it. You can share it later
                  instead.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => close(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating...' : 'Create document'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
