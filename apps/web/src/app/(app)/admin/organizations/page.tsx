'use client';

import { Archive, Copy, Eye, Flame, Pause, Play, Plus, RotateCcw, Search, Send, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import type {
  ActiveSupportGrant,
  CreateOrganizationResponse,
  InviteOrganizationOwnerResponse,
  OrganizationSummary,
} from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  useAdminOrganizations,
  useArchiveOrganization,
  useCreateOrganization,
  useHardDeleteOrganization,
  useInviteOrganizationOwner,
  useMailHealthProbe,
  useRestoreOrganization,
  useToggleOrganizationActive,
} from '@/hooks/use-organizations';
import {
  useActiveSupportGrants,
  useStartSupportSession,
  useSupportEndedNotice,
} from '@/hooks/use-support-access';
import { absoluteTime, relativeTime } from '@/lib/time';
import { describeError, toast, toastErrorMessage } from '@/lib/toast';
import { cn, formatBytes } from '@/lib/utils';

const ROOT_ORG_ID = 'org_root_thebotss';

export default function AdminOrganizationsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  // Single dialog drives both archive and hard-delete. The user picks the
  // mode inside the dialog so the destructive option is not a single click
  // away from the row's trash icon.
  const [deleteTarget, setDeleteTarget] = useState<OrganizationSummary | null>(null);
  // Retroactive owner-invite target. Same shape of dialog as the create
  // flow's success step but invoked from a tenant row that has no owner.
  const [inviteTarget, setInviteTarget] = useState<OrganizationSummary | null>(null);

  const list = useAdminOrganizations();
  // Orgs whose admins currently allow support access ("Open as support").
  const supportGrants = useActiveSupportGrants();
  const startSupport = useStartSupportSession();
  const supportEnded = useSupportEndedNotice();
  const toggleActive = useToggleOrganizationActive();
  const softDelete = useArchiveOrganization();
  const restore = useRestoreOrganization();
  const hardDelete = useHardDeleteOrganization();

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const [search, setSearch] = useState('');
  // Full tenant list loads at once, so filter client-side by name / slug /
  // email domain.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.slug.toLowerCase().includes(q) ||
        (o.emailDomain ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Organizations</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Tenant organizations on this platform. Global admin only.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New tenant
        </Button>
      </header>

      {supportEnded ? (
        <p
          role="status"
          className="rounded-md border border-line bg-bg-subtle px-3 py-2 text-sm text-ink-muted"
        >
          Your support session ended because the organization revoked access, the
          grant expired, or the organization was suspended.
        </p>
      ) : null}

      <div className="relative max-w-sm">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, slug, or domain…"
          aria-label="Search organizations"
          className="input h-9 w-full pl-8 text-sm"
        />
      </div>

      <section className="rounded-lg border border-line bg-white">
        <div className="overflow-x-auto">
          {list.isLoading ? (
            <div className="flex justify-center px-4 py-8">
              <Loader size="sm" label="Loading" />
            </div>
          ) : list.isError && !list.data ? (
            <QueryError message="Couldn't load organizations." onRetry={() => void list.refetch()} />
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              {search.trim() ? 'No organizations match your search.' : 'No organizations yet.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Slug</th>
                  <th className="px-4 py-2">Email domain</th>
                  <th className="px-4 py-2 text-right">Members</th>
                  <th className="px-4 py-2 text-right">Workspaces</th>
                  <th className="px-4 py-2 text-right">Storage</th>
                  <th className="px-4 py-2">Mail</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((org) => (
                  <OrgRow
                    key={org.id}
                    org={org}
                    onToggle={(next) =>
                      toggleActive.mutate({ orgId: org.id, isActive: next })
                    }
                    onDelete={() => setDeleteTarget(org)}
                    onRestore={() => restore.mutate(org.id)}
                    onInviteOwner={() => setInviteTarget(org)}
                    supportGrant={supportGrants.data?.get(org.id) ?? null}
                    onOpenSupport={(grantId) => startSupport.mutate(grantId)}
                    supportPending={startSupport.isPending}
                    pending={
                      toggleActive.isPending ||
                      softDelete.isPending ||
                      hardDelete.isPending ||
                      restore.isPending
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <CreateOrgDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => setCreateOpen(false)}
      />

      <DeleteOrgDialog
        target={deleteTarget}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        onArchive={async (id) => {
          try {
            await softDelete.mutateAsync(id);
            setDeleteTarget(null);
          } catch {
            // toasted by the hook's onError; keep the dialog open to retry
          }
        }}
        onHardDelete={async (id) => {
          try {
            await hardDelete.mutateAsync(id);
            setDeleteTarget(null);
          } catch {
            // toasted by the hook's onError; keep the dialog open to retry
          }
        }}
        pending={softDelete.isPending || hardDelete.isPending}
      />

      <InviteOwnerDialog
        target={inviteTarget}
        onOpenChange={(next) => {
          if (!next) setInviteTarget(null);
        }}
        onDone={() => setInviteTarget(null)}
      />
    </div>
  );
}

function OrgRow({
  org,
  onToggle,
  onDelete,
  onRestore,
  onInviteOwner,
  supportGrant,
  onOpenSupport,
  supportPending,
  pending,
}: {
  org: OrganizationSummary;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
  onRestore: () => void;
  onInviteOwner: () => void;
  /** The org's active support grant, when its admins allow support now. */
  supportGrant: ActiveSupportGrant | null;
  onOpenSupport: (grantId: string) => void;
  supportPending: boolean;
  pending: boolean;
}) {
  const isRoot = org.isRoot;
  const isArchived = org.deletedAt !== null;
  // Surface the "Invite / resend owner invite" action on every active
  // tenant org. The backend's `inviteFirstOwner` handles three shapes
  // intelligently:
  //   - No user with that email yet → standard first-owner invite.
  //   - User exists in this org, still pending (no credential) → resend
  //     the existing invitation token + email (use this when the prior
  //     email never arrived, e.g. before the OrganizationMailConfig
  //     routing fix).
  //   - User exists elsewhere or has already accepted → 409.
  // Showing the button broadly lets the admin recover stuck orgs without
  // having to remember which path they're on.
  const canInviteOwner = !isRoot && !isArchived;
  return (
    <tr
      className={cn(
        'border-t border-line',
        (isArchived || !org.isActive) && 'opacity-60',
      )}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isRoot ? (
            <span
              title="Botss root - immutable"
              className="whitespace-nowrap inline-flex items-center gap-1 rounded-full bg-tint-warning px-2 py-0.5 text-[10px] font-medium text-brand-orange"
            >
              <ShieldCheck className="h-3 w-3" />
              Root
            </span>
          ) : null}
          <span className="font-medium text-ink">{org.name}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-xs text-ink-muted">{org.slug}</td>
      <td className="px-4 py-3 text-xs text-ink-muted">
        {org.emailDomain ?? <span className="italic text-ink-disabled">none</span>}
      </td>
      <td className="px-4 py-3 text-right text-sm text-ink">{org.memberCount}</td>
      <td className="px-4 py-3 text-right text-sm text-ink">{org.workspaceCount}</td>
      <td className="px-4 py-3 text-right text-sm text-ink whitespace-nowrap">
        {formatBytes(org.storageBytes ?? 0)}
      </td>
      <td className="px-4 py-3 text-xs text-ink-muted">
        {org.mailConfigured ? 'Set up' : 'Not set up'}
      </td>
      <td className="px-4 py-3">
        <Badge
          tone={
            isArchived
              ? 'danger'
              : !org.isActive
                ? 'neutral'
                : org.pending
                  ? 'warning'
                  : 'success'
          }
        >
          {isArchived
            ? 'Archived'
            : !org.isActive
              ? 'Suspended'
              : org.pending
                ? 'Pending'
                : 'Active'}
        </Badge>
      </td>
      <td className="px-4 py-3 text-xs text-ink-muted">
        <span title={absoluteTime(org.createdAt)}>{relativeTime(org.createdAt)}</span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-1">
          {supportGrant && !isArchived && org.isActive ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenSupport(supportGrant.grantId)}
              disabled={supportPending}
              title={`Read only, until ${absoluteTime(supportGrant.expiresAt)}${
                supportGrant.reason ? `. Note: ${supportGrant.reason}` : ''
              }`}
              className="mr-1 whitespace-nowrap"
            >
              <Eye className="h-4 w-4" aria-hidden />
              Open as support
            </Button>
          ) : null}
          {canInviteOwner ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Invite or resend owner"
              onClick={onInviteOwner}
              disabled={pending}
              className="h-7 w-7 text-ink-disabled hover:text-brand-orange disabled:cursor-not-allowed"
              title={
                org.memberCount === 0
                  ? 'Send the first-owner invite email'
                  : 'Resend owner invite (or invite another)'
              }
            >
              <Send className="h-4 w-4" />
            </Button>
          ) : null}
          {isArchived ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Restore organization"
              disabled={isRoot || pending}
              onClick={onRestore}
              className="h-7 w-7 text-ink-disabled hover:text-state-success disabled:cursor-not-allowed"
              title="Restore archived tenant"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={org.isActive ? 'Suspend' : 'Resume'}
              disabled={isRoot || pending}
              onClick={() => onToggle(!org.isActive)}
              className="h-7 w-7 text-ink-disabled hover:text-ink disabled:cursor-not-allowed"
              title={isRoot ? 'Root organization is immutable' : undefined}
            >
              {org.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete options"
            disabled={isRoot || pending}
            onClick={onDelete}
            className="h-7 w-7 text-ink-disabled hover:text-state-error disabled:cursor-not-allowed"
            title={isRoot ? 'Root organization cannot be deleted' : 'Archive or permanently delete'}
          >
            <Archive className="h-4 w-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Dual-mode destructive dialog. The admin chooses Archive (reversible,
 * users blocked from sign-in, data retained) or Permanently delete
 * (irreversible cascade). The hard-delete branch requires typing the
 * tenant's slug to confirm - same convention GitHub uses for repo deletion.
 */
function DeleteOrgDialog({
  target,
  onOpenChange,
  onArchive,
  onHardDelete,
  pending,
}: {
  target: OrganizationSummary | null;
  onOpenChange: (next: boolean) => void;
  onArchive: (id: string) => Promise<void>;
  onHardDelete: (id: string) => Promise<void>;
  pending: boolean;
}) {
  const [mode, setMode] = useState<'archive' | 'hard'>('archive');
  const [confirmText, setConfirmText] = useState('');

  const isArchived = target?.deletedAt !== null;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setMode('archive');
          setConfirmText('');
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target?.name ?? 'organization'}?</DialogTitle>
          <DialogDescription>
            Pick how you want to remove this tenant. Archiving is reversible;
            permanent deletion is not.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label
            className={cn(
              'flex cursor-pointer gap-3 rounded-md border p-3 transition',
              mode === 'archive'
                ? 'border-brand-orange bg-tint-warning/40'
                : 'border-line hover:bg-surface-subtle',
              isArchived && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'archive'}
              onChange={() => setMode('archive')}
              disabled={isArchived ?? false}
              className="mt-0.5"
            />
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2 font-medium text-ink">
                <Archive className="h-4 w-4 text-ink-muted" />
                Archive (reversible)
              </div>
              <p className="text-xs text-ink-muted">
                Users in this tenant lose sign-in. All workspaces, projects, and
                data stay in the database. You can restore at any time.
                {isArchived ? ' This tenant is already archived.' : ''}
              </p>
            </div>
          </label>
          <label
            className={cn(
              'flex cursor-pointer gap-3 rounded-md border p-3 transition',
              mode === 'hard'
                ? 'border-state-error bg-state-error/5'
                : 'border-line hover:bg-surface-subtle',
            )}
          >
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'hard'}
              onChange={() => setMode('hard')}
              className="mt-0.5"
            />
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2 font-medium text-state-error">
                <Flame className="h-4 w-4" />
                Permanently delete (irreversible)
              </div>
              <p className="text-xs text-ink-muted">
                Hard cascade. Every workspace, project, document, file, user,
                attendance row, leave, time entry, and mail account for this
                tenant is dropped forever. There is no undo.
              </p>
            </div>
          </label>
          {mode === 'hard' && target ? (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-slug">
                Type <span className="font-mono font-semibold">{target.slug}</span> to
                confirm
              </Label>
              <Input
                id="confirm-slug"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={target.slug}
                autoComplete="off"
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          {mode === 'archive' ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending || isArchived || !target}
              onClick={() => target && onArchive(target.id)}
            >
              {pending ? 'Archiving…' : 'Archive'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={pending || !target || confirmText !== target?.slug}
              onClick={() => target && onHardDelete(target.id)}
            >
              {pending ? 'Deleting…' : 'Permanently delete'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateOrgDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [emailDomain, setEmailDomain] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  // Post-success surface: when the API returns an invitation URL we replace
  // the form with a "copy this link" panel so the admin can hand the link to
  // the customer even if the email never lands.
  const [invitation, setInvitation] = useState<
    { url: string; email: string; orgName: string } | null
  >(null);

  function reset(): void {
    setName('');
    setSlug('');
    setEmailDomain('');
    setOwnerEmail('');
    setOwnerName('');
    setInvitation(null);
  }

  const create = useCreateOrganization({
    onSuccess: (org: CreateOrganizationResponse) => {
      onCreated();
      if (org.invitationUrl) {
        setInvitation({
          url: withInvitationCode(org.invitationUrl, org.invitationCode),
          email: ownerEmail.trim().toLowerCase(),
          orgName: org.name,
        });
        toast.success('Tenant organization created. Invitation link ready.');
      } else {
        reset();
        toast.success('Tenant organization created.');
      }
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const cleanedSlug = slug.trim().toLowerCase();
    const cleanedDomain = emailDomain.trim().toLowerCase();
    const cleanedOwnerEmail = ownerEmail.trim().toLowerCase();
    const cleanedOwnerName = ownerName.trim();
    if (!name.trim() || !cleanedSlug) {
      toastErrorMessage('Name and slug are required');
      return;
    }
    if (cleanedSlug === 'platform' || cleanedSlug === ROOT_ORG_ID) {
      toastErrorMessage('That slug is reserved');
      return;
    }
    // First admin is required now - an org without an owner is a dead
    // shell the customer can never sign into.
    if (!cleanedOwnerEmail || !cleanedOwnerName) {
      toastErrorMessage('First admin name and email are required');
      return;
    }
    if (cleanedDomain) {
      const ownerDomain = cleanedOwnerEmail.split('@')[1];
      if (ownerDomain !== cleanedDomain) {
        toastErrorMessage(`Owner email must be @${cleanedDomain}`);
        return;
      }
    }
    create.mutate({
      name: name.trim(),
      slug: cleanedSlug,
      ...(cleanedDomain ? { emailDomain: cleanedDomain } : {}),
      firstOwner: {
        email: cleanedOwnerEmail,
        name: cleanedOwnerName,
      },
    });
  }

  async function copyInvitation(): Promise<void> {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.url);
      toast.success('Invitation link copied.');
    } catch {
      toastErrorMessage("Couldn't copy the link", { description: "Your browser blocked clipboard access. Allow it in site settings, or copy it by hand." });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {invitation ? (
          <>
            <DialogHeader>
              <DialogTitle>{invitation.orgName} is set up</DialogTitle>
              <DialogDescription>
                We attempted to email the invitation to{' '}
                <span className="font-medium text-ink">{invitation.email}</span>.
                If it doesn&apos;t arrive in a few minutes (check spam first),
                hand them the link below. Valid for 7 days. The link expires
                automatically after the recipient uses it once.
              </DialogDescription>
            </DialogHeader>

            {/* Prominent invitation URL block: copy is the primary action,
                the diagnostic button below answers "why didn't my email
                arrive" without a context switch into the API logs. */}
            <div className="space-y-3 rounded-lg border border-brand-orange/30 bg-tint-warning/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-brand-orange">
                  Invitation link
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={copyInvitation}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
              <div className="rounded-md border border-line bg-white px-3 py-2 font-mono text-xs break-all whitespace-pre-line text-ink">
                {invitation.url}
              </div>
            </div>

            <MailHealthDiagnostic />

            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create tenant organization</DialogTitle>
              <DialogDescription>
                New tenants are isolated from every other organization. Users who
                sign up with a matching email domain auto-route here.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={submit} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="org-name">Name</Label>
                <Input
                  id="org-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Inc."
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-slug">Slug</Label>
                <Input
                  id="org-slug"
                  value={slug}
                  onChange={(e) =>
                    setSlug(
                      e.target.value.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
                    )
                  }
                  placeholder="acme"
                />
                <p className="text-xs text-ink-muted">
                  Lowercase letters, digits, and dashes. Used in URLs and audit
                  logs.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-domain">
                  Email domain <span className="text-ink-disabled">(optional)</span>
                </Label>
                <Input
                  id="org-domain"
                  value={emailDomain}
                  onChange={(e) => setEmailDomain(e.target.value.toLowerCase())}
                  placeholder="acme.test"
                />
                <p className="text-xs text-ink-muted">
                  Users signing in with this domain auto-route here.
                </p>
              </div>
              <div className="space-y-3 rounded-md border border-line bg-surface-subtle p-3">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-ink">First admin</p>
                  <p className="text-xs text-ink-muted">
                    Required. We&apos;ll create a workspace, make this person
                    the owner, and email them a link to set their password.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="owner-email">
                    Email <span className="text-state-error">*</span>
                  </Label>
                  <Input
                    id="owner-email"
                    type="email"
                    autoComplete="off"
                    required
                    value={ownerEmail}
                    onChange={(e) => setOwnerEmail(e.target.value)}
                    placeholder="owner@acme.test"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="owner-name">
                    Name <span className="text-state-error">*</span>
                  </Label>
                  <Input
                    id="owner-name"
                    required
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="Jane Doe"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => onOpenChange(false)}
                  disabled={create.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? 'Creating…' : 'Create tenant'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Retroactive owner-invite dialog. Mirrors the create-org dialog's success
 * step: collect email + name, fire the API, then show the copyable
 * invitation link with the same affordance in case the email never lands.
 */
function InviteOwnerDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: OrganizationSummary | null;
  onOpenChange: (next: boolean) => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [invitation, setInvitation] = useState<{ url: string; email: string } | null>(null);

  function reset(): void {
    setEmail('');
    setName('');
    setInvitation(null);
  }

  const invite = useInviteOrganizationOwner({
    onSuccess: (resp: InviteOrganizationOwnerResponse) => {
      if (resp.invitationUrl) {
        setInvitation({
          url: withInvitationCode(resp.invitationUrl, resp.invitationCode),
          email: email.trim().toLowerCase(),
        });
        toast.success('Invitation link ready. Share it below or check email delivery.');
      } else {
        reset();
        onDone();
        toast.success('Owner attached. They can sign in with their existing credentials.');
      }
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!target) return;
    const cleanedEmail = email.trim().toLowerCase();
    const cleanedName = name.trim();
    if (!cleanedEmail) {
      toastErrorMessage('Email is required');
      return;
    }
    if (target.emailDomain) {
      const dom = cleanedEmail.split('@')[1];
      if (dom !== target.emailDomain) {
        toastErrorMessage(`Owner email must be @${target.emailDomain}`);
        return;
      }
    }
    invite.mutate({
      orgId: target.id,
      input: {
        email: cleanedEmail,
        ...(cleanedName ? { name: cleanedName } : {}),
      },
    });
  }

  async function copyInvitation(): Promise<void> {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.url);
      toast.success('Invitation link copied.');
    } catch {
      toastErrorMessage("Couldn't copy the link", { description: "Your browser blocked clipboard access. Allow it in site settings, or copy it by hand." });
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {invitation ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation sent</DialogTitle>
              <DialogDescription>
                We emailed{' '}
                <span className="font-medium text-ink">{invitation.email}</span> a
                link to set their password. Valid for 7 days - copy it if the
                email does not arrive.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="rounded-md border border-line bg-surface-subtle px-3 py-2 font-mono text-xs break-all whitespace-pre-line text-ink-muted">
                {invitation.url}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={copyInvitation}
              >
                <Copy className="h-4 w-4" />
                Copy invitation link
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  reset();
                  onDone();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite or resend owner invite</DialogTitle>
              <DialogDescription>
                Send the invitation email for{' '}
                {target?.name ? (
                  <span className="font-medium text-ink">{target.name}</span>
                ) : (
                  'this tenant'
                )}
                . If the email matches an existing pending owner, we resend
                their invitation with a fresh token - useful when an earlier
                attempt never arrived. Otherwise we provision a new owner.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={submit} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={
                    target?.emailDomain
                      ? `owner@${target.emailDomain}`
                      : 'owner@example.com'
                  }
                  autoFocus
                />
                {target?.emailDomain ? (
                  <p className="text-xs text-ink-muted">
                    Must be on the tenant&apos;s declared domain (
                    <span className="font-mono">@{target.emailDomain}</span>).
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-name">
                  Name <span className="text-ink-disabled">(optional)</span>
                </Label>
                <Input
                  id="invite-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    onOpenChange(false);
                    reset();
                  }}
                  disabled={invite.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={invite.isPending}>
                  {invite.isPending ? 'Sending…' : 'Send invite'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Collapsed-by-default "Test mail config" affordance. Pressing the button
 * hits `GET /admin/email/health` which describes the active mail
 * transport and (for the env path) reports whether SMTP verify
 * succeeds. Surface for operators when an invitation email doesn't
 * arrive - lets them tell at a glance whether the platform creds are
 * even valid before chasing Gmail spam filters / DKIM issues.
 */
function MailHealthDiagnostic() {
  const [open, setOpen] = useState(false);
  const probe = useMailHealthProbe();

  return (
    <div className="rounded-md border border-line bg-surface-subtle p-3 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left font-medium text-ink"
        onClick={() => {
          setOpen((v) => !v);
          if (!probe.data && !probe.isPending) probe.mutate();
        }}
      >
        <span>Mail not arriving? Check transport</span>
        <span className="text-ink-muted">{open ? 'Hide' : 'Diagnose'}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-2">
          {probe.isPending ? (
            <p className="text-ink-muted">Pinging SMTP&hellip;</p>
          ) : probe.data ? (
            <div className="space-y-1.5">
              <Row label="Transport" value={transportLabel(probe.data.transport)} />
              {probe.data.host ? (
                <Row
                  label="Host"
                  value={`${probe.data.host}:${probe.data.port ?? '?'}`}
                />
              ) : null}
              {probe.data.fromAddress ? (
                <Row label="From" value={probe.data.fromAddress} />
              ) : null}
              {probe.data.verify ? (
                probe.data.verify.ok ? (
                  <Row label="SMTP verify" value="OK" tone="ok" />
                ) : (
                  <Row
                    label="SMTP verify"
                    value={probe.data.verify.error}
                    tone="error"
                  />
                )
              ) : null}
              {probe.data.transport === 'stub' ? (
                <p className="text-state-error">
                  No mail transport configured. Set <code>SMTP_HOST</code>,
                  <code> SMTP_USER</code>, <code>SMTP_PASSWORD</code>,
                  <code> MAIL_FROM</code> on the API host and reload.
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => probe.mutate()}
                className="text-brand-purple hover:underline"
              >
                Re-run check
              </button>
            </div>
          ) : probe.error ? (
            <p className="text-state-error">
              {describeError(probe.error, "Couldn't reach the diagnostic endpoint.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** An invitation opens only with its link AND its 6-digit code: share both. */
function withInvitationCode(url: string, code: string | null | undefined): string {
  return code ? `${url}\nCode: ${code}` : url;
}

function transportLabel(t: 'env' | 'mail-account' | 'org-mail-config' | 'stub'): string {
  switch (t) {
    case 'env':
      return 'Platform env SMTP';
    case 'mail-account':
      return 'Workspace MailAccount (transactional)';
    case 'org-mail-config':
      return 'OrganizationMailConfig (tenant SMTP)';
    case 'stub':
      return 'Stub (no transport - logs only)';
  }
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'error';
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-28 shrink-0 text-ink-muted">{label}</span>
      <span
        className={cn(
          'font-mono break-all',
          tone === 'ok' && 'text-brand-teal',
          tone === 'error' && 'text-state-error',
          !tone && 'text-ink',
        )}
      >
        {value}
      </span>
    </div>
  );
}
