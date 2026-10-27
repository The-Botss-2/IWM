'use client';

import { Building2, Check, Copy, ExternalLink, Globe, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  Document,
  DocumentAccess,
  DocumentPermission,
  DocumentShareTargets,
} from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import {
  useAddDocumentAccess,
  useClientPortalSharing,
  useDocumentAccess,
  useRemoveDocumentAccess,
  useSetClientPersonAccess,
  useSetDocumentClientShare,
  useUpdateDocumentAccess,
} from '@/hooks/use-document-access';
import {
  useShareDocument,
  useUnshareDocument,
  useUpdateDocument,
} from '@/hooks/use-documents';
import { toastErrorMessage } from '@/lib/toast';

interface Props {
  doc: Document;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ doc, open, onOpenChange }: Props) {
  const share = useShareDocument();
  const unshare = useUnshareDocument();
  const update = useUpdateDocument();
  const [copied, setCopied] = useState(false);

  const isShared = !!doc.publicSlug;
  const publicUrl =
    typeof window !== 'undefined' && doc.publicSlug
      ? `${window.location.origin}/p/${doc.publicSlug}`
      : '';

  const toggleShare = (next: boolean) => {
    if (next) {
      share.mutate({ id: doc.id, input: { publicReadOnly: doc.publicReadOnly } });
    } else {
      unshare.mutate(doc.id);
    }
  };

  const copy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toastErrorMessage("Couldn't copy the link", { description: "Your browser blocked clipboard access. Allow it in site settings, or copy it by hand." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Globe className="h-4 w-4 text-brand-600" aria-hidden />
            Share document
          </DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Share with teammates, with people at your clients through their portal, or with a
            public link.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <InternalAccessSection docId={doc.id} />

          <ClientPortalSection docId={doc.id} />

          <div className="border-t border-line pt-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              <Globe className="h-3.5 w-3.5" aria-hidden /> Public link
            </h3>
            <div className="space-y-3">
              <ToggleRow
                label="Share with public link"
                description={
                  isShared
                    ? 'Anyone with the link can view this document.'
                    : 'Turn on to generate a shareable URL.'
                }
                checked={isShared}
                pending={share.isPending || unshare.isPending}
                onChange={toggleShare}
              />

              {isShared && publicUrl ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="share-url">Public URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="share-url"
                        readOnly
                        value={publicUrl}
                        onFocus={(e) => e.currentTarget.select()}
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void copy()}
                        aria-label="Copy public URL"
                      >
                        {copied ? (
                          <>
                            <Check className="h-4 w-4" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-4 w-4" /> Copy
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-ink">Link expires</p>
                      <p className="text-xs text-ink-muted">
                        {doc.publicExpiresAt
                          ? `Stops working ${new Date(doc.publicExpiresAt).toLocaleString()}.`
                          : 'The link works until you turn sharing off.'}
                      </p>
                    </div>
                    <Select
                      value="__keep__"
                      onValueChange={(v) => {
                        if (v === '__keep__') return;
                        const days = v === 'never' ? null : Number(v);
                        update.mutate({
                          id: doc.id,
                          input: {
                            publicExpiresAt:
                              days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000),
                          },
                        });
                      }}
                      disabled={update.isPending}
                    >
                      <SelectTrigger className="w-40" aria-label="Link expiry">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__keep__">
                          {doc.publicExpiresAt ? 'Change expiry' : 'Never'}
                        </SelectItem>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="1">In 1 day</SelectItem>
                        <SelectItem value="7">In 7 days</SelectItem>
                        <SelectItem value="30">In 30 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <ToggleRow
                    label="Read only"
                    description="Viewers can read but not edit. Editing for public links is not yet supported, so this is effectively always on."
                    checked={doc.publicReadOnly}
                    pending={update.isPending}
                    onChange={(next) =>
                      update.mutate({ id: doc.id, input: { publicReadOnly: next } })
                    }
                  />

                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:text-brand-800"
                  >
                    Open public page
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InternalAccessSection({ docId }: { docId: string }) {
  const list = useDocumentAccess(docId);
  const add = useAddDocumentAccess(docId);
  const update = useUpdateDocumentAccess(docId);
  const remove = useRemoveDocumentAccess(docId);

  const [newUserId, setNewUserId] = useState<string | null>(null);
  const [newPermission, setNewPermission] = useState<DocumentPermission>('READ');

  const excludeIds = useMemo(() => {
    const ids = list.data?.items.map((g) => g.userId) ?? [];
    if (list.data?.owner.id) ids.push(list.data.owner.id);
    return ids;
  }, [list.data]);

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        <Users className="h-3.5 w-3.5" aria-hidden /> People with access
      </h3>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <WorkspaceMembersCombobox
            value={newUserId}
            onChange={setNewUserId}
            placeholder="Add a teammate"
            excludeUserIds={excludeIds}
            clearable={false}
          />
        </div>
        <div className="flex gap-2">
          <Select
            value={newPermission}
            onValueChange={(v) => setNewPermission(v as DocumentPermission)}
          >
            <SelectTrigger className="w-28" aria-label="Permission">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="READ">Read</SelectItem>
              <SelectItem value="WRITE">Write</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              if (!newUserId) {
                toastErrorMessage('Pick a teammate first');
                return;
              }
              add.mutate(
                { userId: newUserId, permission: newPermission },
                {
                  onSuccess: () => {
                    setNewUserId(null);
                  },
                },
              );
            }}
            disabled={add.isPending}
          >
            Add
          </Button>
        </div>
      </div>

      <ul className="space-y-1" role="list">
        {list.data?.owner ? (
          <li className="flex items-center gap-3 rounded-md border border-line bg-bg-subtle px-3 py-2">
            <UserAvatar
              size="sm"
              name={list.data.owner.name || list.data.owner.email}
              image={list.data.owner.image}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">
                {list.data.owner.name || list.data.owner.email}
              </div>
              <div className="truncate text-xs text-ink-muted">{list.data.owner.email}</div>
            </div>
            <span className="text-xs font-medium text-ink-muted">Owner</span>
          </li>
        ) : null}
        {list.isLoading ? (
          <li className="flex justify-center px-3 py-2">
            <Loader size="sm" label="Loading access" />
          </li>
        ) : list.data && list.data.items.length === 0 ? (
          <li className="rounded-md border border-dashed border-line bg-white px-3 py-2 text-xs text-ink-muted">
            No one else has access yet. Add a teammate above.
          </li>
        ) : (
          list.data?.items.map((grant: DocumentAccess) => (
            <AccessRow
              key={grant.id}
              grant={grant}
              onChangePermission={(permission) =>
                update.mutate({ userId: grant.userId, input: { permission } })
              }
              onRemove={() => remove.mutate(grant.userId)}
            />
          ))
        )}
      </ul>
    </section>
  );
}

function AccessRow({
  grant,
  onChangePermission,
  onRemove,
}: {
  grant: DocumentAccess;
  onChangePermission: (permission: DocumentPermission) => void;
  onRemove: () => void;
}) {
  // Client portal people only ever read (the API refuses Write), and their
  // avatar is client-controlled, so it is never loaded in a staff browser.
  const isClient = grant.user.accountType === 'CLIENT';
  return (
    <li className="flex items-center gap-3 rounded-md border border-line bg-white px-3 py-2">
      <UserAvatar
        size="sm"
        name={grant.user.name || grant.user.email}
        image={isClient ? null : grant.user.image}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink">
            {grant.user.name || grant.user.email}
          </span>
          {isClient ? (
            <Badge tone="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              Client
            </Badge>
          ) : null}
        </div>
        <div className="truncate text-xs text-ink-muted">{grant.user.email}</div>
      </div>
      {isClient ? (
        <span className="w-24 shrink-0 px-3.5 text-sm text-ink-muted">Read</span>
      ) : (
        <Select
          value={grant.permission}
          onValueChange={(v) => onChangePermission(v as DocumentPermission)}
        >
          <SelectTrigger className="w-24" aria-label={`Permission for ${grant.user.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="READ">Read</SelectItem>
            <SelectItem value="WRITE">Write</SelectItem>
          </SelectContent>
        </Select>
      )}
      <button
        type="button"
        aria-label={`Remove ${grant.user.name}`}
        onClick={() => {
          if (window.confirm(`Remove ${grant.user.name || grant.user.email} from this document?`)) {
            onRemove();
          }
        }}
        className="rounded p-1.5 text-ink-disabled hover:bg-tint-error hover:text-state-error focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

type ShareTargetClient = DocumentShareTargets['clients'][number];

/**
 * Share with people at a client through their portal: the whole company
 * (everyone with portal access, now and later) or chosen people. Always
 * read-only. The API lets only the document owner and workspace admins
 * share; everyone else sees existing company shares without controls.
 */
function ClientPortalSection({ docId }: { docId: string }) {
  const sharing = useClientPortalSharing(docId);
  const companyShare = useSetDocumentClientShare(docId);
  const personAccess = useSetClientPersonAccess(docId);

  const companyPendingId = companyShare.isPending ? companyShare.variables?.clientId : undefined;
  const personPendingId = personAccess.isPending ? personAccess.variables?.userId : undefined;

  return (
    <section className="border-t border-line pt-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        <Building2 className="h-3.5 w-3.5" aria-hidden /> Client portal
      </h3>
      <p className="mb-3 text-xs text-ink-muted">
        People at a client read shared documents in their portal. They can never edit them.
      </p>

      {sharing.isLoading ? (
        <div className="flex justify-center px-3 py-2">
          <Loader size="sm" label="Loading clients" />
        </div>
      ) : sharing.isError ? (
        <QueryError compact message="Couldn't load clients." onRetry={sharing.retry} />
      ) : (
        <div className="space-y-2">
          {sharing.clients.map((client) => (
            <ClientShareCard
              key={client.id}
              client={client}
              companyPending={companyPendingId === client.id}
              pendingUserId={personPendingId}
              onCompanyChange={(shared) => companyShare.mutate({ clientId: client.id, shared })}
              onPersonChange={(userId, shared) => personAccess.mutate({ userId, shared })}
            />
          ))}
          {sharing.otherShares.map((share) => (
            <div
              key={share.id}
              className="flex items-center gap-3 rounded-md border border-line bg-white px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  Everyone at {share.client.name}
                </p>
                <p className="truncate text-xs text-ink-muted">
                  {share.grantedBy
                    ? `Shared with the company by ${share.grantedBy.name}`
                    : 'Shared with the company'}
                </p>
              </div>
              {sharing.canShare ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={companyPendingId === share.clientId}
                  onClick={() => companyShare.mutate({ clientId: share.clientId, shared: false })}
                >
                  Stop sharing
                </Button>
              ) : null}
            </div>
          ))}
          {sharing.forbidden ? (
            <p className="text-xs text-ink-muted">
              Only the document owner or a workspace admin can share with clients.
            </p>
          ) : sharing.clients.length === 0 && sharing.otherShares.length === 0 ? (
            <p className="rounded-md border border-dashed border-line bg-white px-3 py-2 text-xs text-ink-muted">
              Clients show up here once someone at the client has portal access, or when this
              document belongs to a client&apos;s project.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ClientShareCard({
  client,
  companyPending,
  pendingUserId,
  onCompanyChange,
  onPersonChange,
}: {
  client: ShareTargetClient;
  companyPending: boolean;
  pendingUserId: string | undefined;
  onCompanyChange: (shared: boolean) => void;
  onPersonChange: (userId: string, shared: boolean) => void;
}) {
  const companyId = `client-share-${client.id}`;
  return (
    <div className="rounded-md border border-line bg-white">
      <div className="flex items-start gap-3 p-3">
        <Checkbox
          id={companyId}
          checked={client.companyShared}
          disabled={companyPending}
          onCheckedChange={(v) => onCompanyChange(v === true)}
          aria-describedby={`${companyId}-help`}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor={companyId} className="cursor-pointer leading-snug">
            Share with everyone at {client.name}
          </Label>
          <p id={`${companyId}-help`} className="mt-1 text-xs text-ink-muted">
            {client.people.length === 0
              ? `No one at ${client.name} has portal access yet. People who get it later see this too.`
              : 'Includes people who get portal access later.'}
          </p>
        </div>
      </div>
      {client.people.length > 0 ? (
        <ul className="border-t border-line px-3 py-1.5" aria-label={`People at ${client.name}`}>
          {client.people.map((person) => {
            const personId = `client-person-${client.id}-${person.userId}`;
            return (
              <li key={person.userId} className="flex items-center gap-3 py-1.5">
                <Checkbox
                  id={personId}
                  checked={person.hasAccess}
                  disabled={pendingUserId === person.userId}
                  onCheckedChange={(v) => onPersonChange(person.userId, v === true)}
                />
                <label htmlFor={personId} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block truncate text-sm text-ink">
                    {person.name || person.email}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">{person.email}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {client.companyShared && client.people.length > 0 ? (
        <p className="border-t border-line px-3 py-2 text-xs text-ink-muted">
          Everyone here can already read it through the company share. A person you tick keeps
          access if you stop sharing with the company.
        </p>
      ) : null}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  pending,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  pending?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-md border border-line bg-white p-3">
      <span className="space-y-0.5">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-xs text-ink-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
      />
    </label>
  );
}
