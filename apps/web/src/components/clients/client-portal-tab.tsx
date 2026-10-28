'use client';

import {
  Check,
  Copy,
  KeyRound,
  MailCheck,
  MailWarning,
  RefreshCw,
  Star,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type {
  ClientContact,
  ClientContactLinkResponse,
  ClientContactRole,
} from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
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
import { QueryError } from '@/components/ui/query-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import {
  parsePortalInvite,
  portalContactErrorMessage,
  useClientPortalContacts,
  useInvitePortalContact,
  useResendPortalInvite,
  useRevokePortalContact,
  useSendPortalPasswordReset,
  useSetPortalContactRole,
} from '@/hooks/use-client-portal';
import { absoluteTime, relativeTime } from '@/lib/time';
import { markErrorReported, toast, toastErrorMessage } from '@/lib/toast';

type LinkAction = 'invite' | 'resend' | 'reset';

interface LinkResult {
  action: LinkAction;
  response: ClientContactLinkResponse;
}

const ROLE_LABEL: Record<ClientContactRole, string> = {
  PRIMARY: 'Main contact',
  MEMBER: 'Member',
};

const ROLE_OPTIONS: { value: ClientContactRole; description: string }[] = [
  { value: 'PRIMARY', description: 'Also sees invoices, contracts and payments.' },
  { value: 'MEMBER', description: 'Sees projects, shared documents and signature requests.' },
];

// The expiry itself comes from the API (`linkExpiresAt`), so this copy never
// drifts from the server's link lifetimes.
const LINK_COPY: Record<LinkAction, { sent: string; ready: string; note: string }> = {
  invite: {
    sent: 'Invite sent',
    ready: 'Invite link ready',
    note: 'The link lets them set a password.',
  },
  resend: {
    sent: 'New invite sent',
    ready: 'New invite link ready',
    note: 'The link lets them set a password. Earlier invite links no longer work.',
  },
  reset: {
    sent: 'Password reset link sent',
    ready: 'Password reset link ready',
    note: 'The link lets them choose a new password.',
  },
};

function displayName(c: ClientContact): string {
  return c.user.name || c.user.email;
}

/**
 * Client detail > Portal: who at this client can sign in to the client
 * portal. Everyone may look; workspace owners and admins (`canManage`, a UX
 * hint the API enforces) invite, re-rank and remove people.
 */
export function ClientPortalTab({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const contacts = useClientPortalContacts(clientId);
  const resend = useResendPortalInvite(clientId);
  const reset = useSendPortalPasswordReset(clientId);
  const setRole = useSetPortalContactRole(clientId);
  const revoke = useRevokePortalContact(clientId);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [linkResult, setLinkResult] = useState<LinkResult | null>(null);
  // The current main contact is captured when the dialog opens, so the copy
  // does not change under the optimistic update while the request runs.
  const [promote, setPromote] = useState<{
    contact: ClientContact;
    replaces: ClientContact | null;
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ClientContact | null>(null);

  const items = contacts.data?.items ?? [];
  const canManage = contacts.data?.canManage ?? false;
  const mainContact = items.find((c) => c.role === 'PRIMARY') ?? null;

  function showResult(action: LinkAction, response: ClientContactLinkResponse) {
    if (response.link) {
      setLinkResult({ action, response });
      return;
    }
    // No link: they already had a portal password, so they only got a note.
    const who = response.contact.user.name || response.contact.user.email;
    toast.success(
      response.emailed
        ? `${who} can now open this portal with their existing password. An email notification has been queued.`
        : `${who} can now open this portal with their existing password. Email is not set up, so let them know directly.`,
    );
  }

  async function handleResend(contact: ClientContact) {
    try {
      showResult('resend', await resend.mutateAsync(contact.id));
    } catch {
      // The hook shows the error toast.
    }
  }

  async function handleReset(contact: ClientContact) {
    try {
      showResult('reset', await reset.mutateAsync(contact.id));
    } catch {
      // The hook shows the error toast.
    }
  }

  return (
    <>
      <section
        aria-labelledby="client-portal-heading"
        className="border-line rounded-lg border bg-white p-5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id="client-portal-heading" className="text-ink text-base font-semibold">
              Portal access
            </h2>
            <p className="text-ink-muted mt-1 max-w-2xl text-sm">
              People at {clientName} who can sign in to the client portal. Everything there is read
              only, and people show as pending until they set a password.
            </p>
          </div>
          {canManage ? (
            <Button size="sm" className="shrink-0 self-start" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden />
              Invite person
            </Button>
          ) : null}
        </div>

        <div className="bg-bg-subtle mt-4 rounded-md px-4 py-3">
          <h3 className="text-ink-muted text-xs font-semibold uppercase tracking-wide">
            What they see
          </h3>
          <ul className="text-ink marker:text-ink-disabled mt-2 list-disc space-y-1 pl-4 text-sm">
            <li>
              Progress on this client&apos;s projects that are shown in the portal (project
              Settings, Client portal). Task lists show only tasks marked for the client, unless the
              project shows all tasks.
            </li>
            <li>Documents shared with {clientName} or with them personally.</li>
            <li>Signature requests sent to their email.</li>
            <li>Invoices, contracts and payments, for the main contact only.</li>
          </ul>
        </div>

        <div className="mt-4 overflow-x-auto">
          {contacts.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : contacts.isError ? (
            <QueryError
              message="Couldn't load portal access."
              onRetry={() => void contacts.refetch()}
            />
          ) : items.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="text-ink-muted text-left text-xs font-medium uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">Person</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Last seen</th>
                  {canManage ? (
                    <th className="px-3 py-2 text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <ContactRow
                    key={c.id}
                    contact={c}
                    canManage={canManage}
                    resending={resend.isPending && resend.variables === c.id}
                    resetting={reset.isPending && reset.variables === c.id}
                    onResend={() => void handleResend(c)}
                    onReset={() => void handleReset(c)}
                    onPromote={() => setPromote({ contact: c, replaces: mainContact })}
                    onRevoke={() => setRevokeTarget(c)}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <div className="border-line rounded-md border border-dashed p-6 text-center">
              <p className="text-ink text-sm font-medium">
                No one at {clientName} has portal access yet.
              </p>
              <p className="text-ink-muted mt-1 text-sm">
                {canManage
                  ? 'Start with the main contact, the person who handles invoices and contracts.'
                  : 'Workspace owners and admins can invite people here.'}
              </p>
            </div>
          )}
        </div>

        {!canManage && items.length > 0 ? (
          <p className="text-ink-muted mt-3 text-xs">
            Only workspace owners and admins can invite or remove people.
          </p>
        ) : null}
      </section>

      {inviteOpen ? (
        <InvitePersonDialog
          clientId={clientId}
          clientName={clientName}
          defaultRole={items.length === 0 ? 'PRIMARY' : 'MEMBER'}
          mainContact={mainContact}
          onClose={() => setInviteOpen(false)}
          onInvited={(response) => {
            setInviteOpen(false);
            showResult('invite', response);
          }}
        />
      ) : null}

      {linkResult ? (
        <PortalLinkDialog result={linkResult} onClose={() => setLinkResult(null)} />
      ) : null}

      <ConfirmDialog
        open={promote !== null}
        onOpenChange={(next) => {
          if (!next) setPromote(null);
        }}
        title={promote ? `Make ${displayName(promote.contact)} the main contact?` : ''}
        description={
          promote
            ? promote.replaces && promote.replaces.id !== promote.contact.id
              ? `${displayName(promote.contact)} will also see invoices, contracts and payments. ${displayName(promote.replaces)} becomes a member and stops seeing them.`
              : `${displayName(promote.contact)} will also see invoices, contracts and payments.`
            : ''
        }
        confirmLabel="Make main contact"
        pending={setRole.isPending}
        onConfirm={async () => {
          if (!promote) return;
          const name = displayName(promote.contact);
          try {
            await setRole.mutateAsync({ contactId: promote.contact.id, role: 'PRIMARY' });
            toast.success(`${name} is now the main contact.`);
          } catch {
            // The hook shows the error toast.
          }
          setPromote(null);
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        title={revokeTarget ? `Remove ${displayName(revokeTarget)}'s portal access?` : ''}
        description={
          revokeTarget
            ? `${displayName(revokeTarget)} loses access to ${clientName}'s portal right away, and any invite or reset link they have stops working.${
                revokeTarget.role === 'PRIMARY'
                  ? ` Nobody at ${clientName} sees invoices and contracts until you make someone else the main contact.`
                  : ''
              }`
            : ''
        }
        confirmLabel="Remove access"
        variant="destructive"
        pending={revoke.isPending}
        onConfirm={async () => {
          if (!revokeTarget) return;
          const name = displayName(revokeTarget);
          try {
            await revoke.mutateAsync(revokeTarget.id);
            toast.success(`${name} no longer has portal access.`);
          } catch {
            // The hook shows the error toast.
          }
          setRevokeTarget(null);
        }}
      />
    </>
  );
}

function ContactRow({
  contact: c,
  canManage,
  resending,
  resetting,
  onResend,
  onReset,
  onPromote,
  onRevoke,
}: {
  contact: ClientContact;
  canManage: boolean;
  resending: boolean;
  resetting: boolean;
  onResend: () => void;
  onReset: () => void;
  onPromote: () => void;
  onRevoke: () => void;
}) {
  const name = displayName(c);
  const pending = c.status === 'PENDING';
  return (
    <tr className="border-line border-t">
      <td className="px-3 py-3">
        <div className="flex items-center gap-3">
          {/* No image on purpose: it is client-controlled. Initials only. */}
          <UserAvatar size="md" name={name} />
          <div className="min-w-0">
            <div className="text-ink truncate text-sm font-medium">{name}</div>
            <div className="text-ink-muted truncate text-xs">{c.user.email}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <Badge tone={c.role === 'PRIMARY' ? 'brand' : 'neutral'}>{ROLE_LABEL[c.role]}</Badge>
      </td>
      <td className="px-3 py-3">
        {pending ? (
          <Badge tone="neutral">Pending</Badge>
        ) : (
          <Badge tone="info">
            <MailCheck className="h-3 w-3" aria-hidden />
            Active
          </Badge>
        )}
      </td>
      <td className="text-ink-muted hidden px-3 py-3 text-xs sm:table-cell">
        {c.lastSeenAt ? (
          <span title={absoluteTime(c.lastSeenAt)}>{relativeTime(c.lastSeenAt)}</span>
        ) : (
          'Never'
        )}
      </td>
      {canManage ? (
        <td className="px-3 py-3 text-right">
          <div className="flex justify-end gap-1">
            {pending ? (
              <RowAction
                tooltip="Resend invite"
                label={`Resend the invite to ${c.user.email}`}
                onClick={onResend}
                disabled={resending}
              >
                <RefreshCw className="text-ink-muted h-4 w-4" aria-hidden />
              </RowAction>
            ) : (
              <RowAction
                tooltip="Send password reset link"
                label={`Send a password reset link to ${c.user.email}`}
                onClick={onReset}
                disabled={resetting}
              >
                <KeyRound className="text-ink-muted h-4 w-4" aria-hidden />
              </RowAction>
            )}
            {c.role === 'MEMBER' ? (
              <RowAction
                tooltip="Make main contact"
                label={`Make ${name} the main contact`}
                onClick={onPromote}
              >
                <Star className="text-ink-muted h-4 w-4" aria-hidden />
              </RowAction>
            ) : null}
            <RowAction
              tooltip="Remove access"
              label={`Remove portal access for ${name}`}
              onClick={onRevoke}
            >
              <UserMinus className="text-ink-muted h-4 w-4" aria-hidden />
            </RowAction>
          </div>
        </td>
      ) : null}
    </tr>
  );
}

function RowAction({
  tooltip,
  label,
  onClick,
  disabled,
  children,
}: {
  tooltip: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={tooltip}>
      <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} disabled={disabled}>
        {children}
      </Button>
    </Tooltip>
  );
}

/** Mounted only while open, so every invite starts from a clean form. */
function InvitePersonDialog({
  clientId,
  clientName,
  defaultRole,
  mainContact,
  onClose,
  onInvited,
}: {
  clientId: string;
  clientName: string;
  defaultRole: ClientContactRole;
  mainContact: ClientContact | null;
  onClose: () => void;
  onInvited: (response: ClientContactLinkResponse) => void;
}) {
  const invite = useInvitePortalContact(clientId);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ClientContactRole>(defaultRole);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const parsed = parsePortalInvite({ email, name, role });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    try {
      onInvited(await invite.mutateAsync(parsed.input));
    } catch (err) {
      markErrorReported(); // shown inline in the dialog, not as a toast
      setError(portalContactErrorMessage(err, "Couldn't send the invite. Try again."));
    }
  }

  const roleHint =
    role === 'PRIMARY' && mainContact
      ? `${displayName(mainContact)} is the main contact now and becomes a member.`
      : 'Only the main contact sees invoices and contracts. Each client has one main contact.';

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Stay open while sending: a failure is shown in this form, and
        // closing now would swallow it.
        if (!next && !invite.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Invite to the client portal</DialogTitle>
          <DialogDescription className="text-ink-muted text-sm">
            They get a link to set a password, then see {clientName}&apos;s portal.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="portal-invite-email">Email</Label>
            <Input
              id="portal-invite-email"
              type="email"
              autoFocus
              autoComplete="off"
              maxLength={254}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
              placeholder="name@company.com"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'portal-invite-error' : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="portal-invite-name">Name (optional)</Label>
            <Input
              id="portal-invite-name"
              autoComplete="off"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="portal-invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as ClientContactRole)}>
              <SelectTrigger id="portal-invite-role" aria-describedby="portal-invite-role-hint">
                <SelectValue>{ROLE_LABEL[role]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    <span className="flex flex-col">
                      <span>{ROLE_LABEL[r.value]}</span>
                      <span className="text-ink-muted text-xs">{r.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="portal-invite-role-hint" className="text-ink-muted text-xs">
              {roleHint}
            </p>
          </div>
          {error ? (
            <p
              id="portal-invite-error"
              role="alert"
              className="bg-tint-error text-state-error rounded-md border border-red-100 px-3 py-2 text-xs"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter className="pt-1">
            <Button variant="secondary" onClick={onClose} disabled={invite.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shown after an invite, resend or reset that minted a link. The link comes
 * back even when mail went out, because mail can be slow; when no mail
 * transport is set up it is the only way the person gets in.
 */
function PortalLinkDialog({ result, onClose }: { result: LinkResult; onClose: () => void }) {
  const { action, response } = result;
  const link = response.link ?? '';
  const who = response.contact.user.name || response.contact.user.email;
  const copy = LINK_COPY[action];
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toastErrorMessage("Couldn't copy the link", {
        description:
          'Your browser blocked clipboard access. Allow it in site settings, or copy it by hand.',
      });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {response.emailed ? copy.sent : copy.ready}
          </DialogTitle>
          <DialogDescription className="text-ink-muted text-sm">
            {response.emailed
              ? `We emailed ${response.contact.user.email}. If it does not arrive, copy the link and send it to ${who} yourself.`
              : `For ${who} (${response.contact.user.email}).`}
          </DialogDescription>
        </DialogHeader>
        {response.emailed ? null : (
          <div
            role="status"
            className="border-brand-orange/30 bg-tint-warning text-ink flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <MailWarning className="text-brand-orange mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              Email is not set up, so nothing was sent. Copy the link and send it to {who} yourself.
            </p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="portal-link">Link</Label>
          <div className="flex gap-2">
            <Input
              id="portal-link"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button variant="secondary" className="shrink-0" onClick={() => void copyLink()}>
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
          <p className="text-ink-muted text-xs">
            {copy.note}
            {response.linkExpiresAt ? ` It expires ${absoluteTime(response.linkExpiresAt)}.` : null}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
