'use client';

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  MoreHorizontal,
  PenLine,
  Plus,
  Sparkles,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MailAccount, MailAccountStatus, MailSignature } from '@botss/shared-types';

import { AddMailAccountDialog } from '@/components/mail/add-mail-account-dialog';
import { MailEditor } from '@/components/mail/mail-editor';
import { SelfSetupMailboxDialog } from '@/components/mail/self-setup-mailbox-dialog';
import { useSessionContext } from '@/components/auth/session-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Tooltip } from '@/components/ui/tooltip';
import {
  useAddMailSignature,
  useMailAccounts,
  useRemoveMailAccount,
  useRemoveMailSignature,
  useTestMailAccount,
  useUpdateMailAccount,
  useUpdateMailSignature,
} from '@/hooks/use-mail-accounts';
import { promptDialog } from '@/lib/prompt';
import { relativeTime } from '@/lib/time';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

// Domain of mailboxes the server auto-provisions for. Mirrors CPANEL_DOMAIN
// on the API side; the web build can't read the API env, so it is set again
// as NEXT_PUBLIC_CPANEL_DOMAIN at build time.
const ROOT_ORG_ID = 'org_root_thebotss';
// Empty when unset: then no one is offered self-serve mailbox setup.
const CPANEL_DOMAIN = (process.env.NEXT_PUBLIC_CPANEL_DOMAIN ?? '').trim().toLowerCase();

export default function MailSettingsPage() {
  const session = useSessionContext();
  const accounts = useMailAccounts();
  const [addOpen, setAddOpen] = useState(false);
  const [selfSetupOpen, setSelfSetupOpen] = useState(false);

  const items = accounts.data?.items ?? [];
  const userEmail = (session.data?.user?.email ?? '').toLowerCase();
  // The cPanel server is the platform's: only root-org users can self-set up.
  const isOnCpanelDomain =
    !!CPANEL_DOMAIN &&
    session.data?.user?.organizationId === ROOT_ORG_ID &&
    userEmail.endsWith(`@${CPANEL_DOMAIN}`);
  const hasOwnMailbox = items.some(
    (a) => a.email.toLowerCase() === userEmail && a.status !== 'DISABLED',
  );
  // Offer the one-click path only when it would actually do something useful:
  // user is on the managed domain and doesn't already have a working
  // MailAccount for their address.
  const showSelfSetup = isOnCpanelDomain && !hasOwnMailbox;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ink text-lg font-semibold">Mail settings</h2>
          <p className="text-ink-muted mt-1 text-sm">
            Connect your IMAP and SMTP credentials so you can read mail inside The Botss, manage the
            signatures appended to your outgoing mail, and let workspace invitations and password
            resets send from your own mailbox.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {showSelfSetup ? (
            <Button onClick={() => setSelfSetupOpen(true)}>
              <Sparkles className="h-4 w-4" />
              Set up my mailbox
            </Button>
          ) : null}
          {/* Manual "Add account" is hidden for users on the managed cPanel
              domain - their flow is the one-click self-setup above. External
              users (gmail, outlook, custom IMAP) still need the manual path
              as a fallback because we can't provision their mailbox for them. */}
          {!isOnCpanelDomain ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add account
            </Button>
          ) : null}
        </div>
      </header>

      {accounts.isLoading ? (
        <div className="border-line bg-bg-surface rounded-md border p-6 text-center">
          <Loader size="sm" label="Loading accounts" />
        </div>
      ) : accounts.isError && !accounts.data ? (
        <QueryError message="Couldn't load mailboxes." onRetry={() => void accounts.refetch()} />
      ) : items.length === 0 ? (
        <div className="border-line-strong bg-bg-surface rounded-md border border-dashed p-8 text-center">
          <Mail className="text-ink-disabled mx-auto h-8 w-8" aria-hidden />
          <h2 className="text-ink mt-3 text-base font-medium">No mailboxes connected yet</h2>
          <p className="text-ink-muted mt-1 text-sm">
            Add your first mailbox to send and receive email from inside the platform.
          </p>
          <Button className="mt-4" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add a mailbox
          </Button>
        </div>
      ) : (
        <ul className="space-y-3" role="list">
          {items.map((a) => (
            <li key={a.id}>
              <AccountCard account={a} />
            </li>
          ))}
        </ul>
      )}

      <section className="border-line bg-bg-subtle text-ink-muted rounded-md border px-4 py-3 text-xs">
        <p className="text-ink font-medium">A note about security</p>
        <p className="mt-1">
          Your mailbox password is encrypted with AES-256-GCM before storage and is never returned
          in API responses. Anyone with workspace admin access can still send mail from a default
          mailbox, so use a service account rather than a personal mailbox where possible.
        </p>
      </section>

      <AddMailAccountDialog open={addOpen} onOpenChange={setAddOpen} />
      <SelfSetupMailboxDialog
        open={selfSetupOpen}
        onOpenChange={setSelfSetupOpen}
        email={userEmail}
      />
    </div>
  );
}

function AccountCard({ account }: { account: MailAccount }) {
  const test = useTestMailAccount();
  const update = useUpdateMailAccount();
  const remove = useRemoveMailAccount();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <article className="border-line bg-bg-surface rounded-md border p-4">
      <div className="flex items-start gap-3">
        <div className="bg-brand-50 text-brand-700 grid h-9 w-9 shrink-0 place-items-center rounded-md">
          <Mail className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink truncate text-sm font-semibold">
              {account.displayName || account.email}
            </span>
            {account.isDefault ? (
              <Badge tone="brand" className="shrink-0">
                Default
              </Badge>
            ) : null}
            <StatusBadge status={account.status} />
          </div>
          {account.displayName ? (
            <div className="text-ink-muted truncate text-xs">{account.email}</div>
          ) : null}
          <div className="text-ink-disabled mt-1 truncate text-[11px]">
            IMAP {account.imapHost}:{account.imapPort}
            {account.imapSecure ? ' (TLS)' : ''} · SMTP {account.smtpHost}:{account.smtpPort}
            {account.smtpSecure ? ' (TLS)' : ''}
          </div>
          {account.lastError ? (
            <p className="bg-tint-error text-state-error mt-2 rounded border border-red-100 px-2 py-1.5 text-xs">
              {account.lastError}
            </p>
          ) : null}
          {account.lastSyncedAt ? (
            <div className="text-ink-disabled mt-1 text-[11px]">
              Last verified {relativeTime(account.lastSyncedAt)}
            </div>
          ) : null}
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="Account actions"
            onClick={() => setMenuOpen((o) => !o)}
            onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
            className="text-ink-disabled hover:bg-bg-subtle hover:text-ink focus-visible:shadow-focus rounded p-1.5 focus-visible:outline-none focus-visible:ring-2"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div className="border-line bg-bg-surface absolute right-0 z-10 mt-1 w-max min-w-[12rem] rounded-md border py-1 shadow-md">
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  test.mutate(account.id);
                }}
                disabled={test.isPending}
              >
                {test.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Test connection
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  update.mutate({
                    id: account.id,
                    input: { isDefault: !account.isDefault },
                  });
                }}
              >
                {account.isDefault ? (
                  <>
                    <StarOff className="h-3.5 w-3.5" />
                    Unset as default
                  </>
                ) : (
                  <>
                    <Star className="h-3.5 w-3.5" />
                    Set as default
                  </>
                )}
              </MenuItem>
              <div className="border-line my-1 border-t" />
              <MenuItem
                tone="danger"
                onClick={() => {
                  setMenuOpen(false);
                  if (window.confirm(`Disconnect ${account.email}? You can re-add it later.`)) {
                    remove.mutate(account.id);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Disconnect
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>

      <SignatureManager account={account} />
    </article>
  );
}

/**
 * Gmail-style signature manager, rendered inline on the Mail settings tab (no
 * dialog). Lists the account's named signatures, lets the user create / rename
 * / delete / edit them, and pick which signature is the default for new mail
 * vs replies/forwards - plus whether the signature sits above the quoted text
 * in replies. All mutations return the refreshed account, so the cache stays
 * in sync without a manual refetch.
 */
function SignatureManager({ account }: { account: MailAccount }) {
  const add = useAddMailSignature();
  const updateSig = useUpdateMailSignature();
  const removeSig = useRemoveMailSignature();
  const updateAccount = useUpdateMailAccount();

  const signatures = account.signatures;
  const [selectedId, setSelectedId] = useState<string | null>(signatures[0]?.id ?? null);
  const htmlRef = useRef<string>('');

  // Keep a valid selection as signatures are added or removed. After a create
  // the newest signature (appended last) becomes the active one.
  useEffect(() => {
    if (signatures.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !signatures.some((s) => s.id === selectedId)) {
      setSelectedId(signatures[signatures.length - 1]!.id);
    }
  }, [signatures, selectedId]);

  const selected = signatures.find((s) => s.id === selectedId) ?? null;

  // Seed the editor buffer only when the active signature actually changes
  // (manual pick, or auto-select after add/remove) - NOT when an unrelated
  // mutation (e.g. flipping a default) returns a fresh signatures array, which
  // would otherwise clobber unsaved typing. onChange keeps it current as the
  // user types.
  const seededForId = useRef<string | null>(null);
  useEffect(() => {
    if (seededForId.current === selectedId) return;
    seededForId.current = selectedId;
    htmlRef.current = signatures.find((s) => s.id === selectedId)?.html ?? '';
  }, [selectedId, signatures]);

  const createNew = async () => {
    const name = await promptDialog({
      title: 'New signature',
      description: 'Give this signature a name.',
      defaultValue: 'New signature',
      confirmLabel: 'Create',
    });
    if (!name?.trim()) return;
    add.mutate({ accountId: account.id, input: { name: name.trim(), html: '' } });
  };

  const rename = async (sig: MailSignature) => {
    const name = await promptDialog({
      title: 'Rename signature',
      defaultValue: sig.name,
      confirmLabel: 'Rename',
    });
    if (!name?.trim() || name.trim() === sig.name) return;
    updateSig.mutate({
      accountId: account.id,
      signatureId: sig.id,
      input: { name: name.trim() },
    });
  };

  const del = (sig: MailSignature) => {
    if (!window.confirm(`Delete the "${sig.name}" signature?`)) return;
    removeSig.mutate({ accountId: account.id, signatureId: sig.id });
  };

  const saveHtml = () => {
    if (!selected) return;
    updateSig.mutate(
      {
        accountId: account.id,
        signatureId: selected.id,
        input: { html: htmlRef.current },
      },
      { onSuccess: () => toast.success('Signature saved.') },
    );
  };

  const setDefault = (field: 'newSignatureId' | 'replySignatureId', value: string) => {
    updateAccount.mutate({
      id: account.id,
      input: { [field]: value || null },
    });
  };

  return (
    <section className="border-line mt-3 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ink text-sm font-semibold">Signature</h3>
        <p className="text-ink-disabled text-[11px]">
          Appended to outgoing mail from this account.
        </p>
      </div>

      {signatures.length === 0 ? (
        <div className="border-line-strong bg-bg-subtle mt-3 rounded-md border border-dashed p-5 text-center">
          <p className="text-ink-muted text-sm">No signatures yet.</p>
          <Button
            type="button"
            className="mt-3"
            onClick={() => void createNew()}
            disabled={add.isPending}
          >
            <Plus className="h-4 w-4" />
            Create new
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
          {/* Signature list */}
          <div className="space-y-1">
            <ul className="border-line bg-bg-surface rounded-md border" role="list">
              {signatures.map((s) => (
                <li
                  key={s.id}
                  className={cn(
                    'border-line flex items-center gap-1 border-b px-2 py-1.5 last:border-b-0',
                    s.id === selectedId ? 'bg-bg-subtle' : '',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className="text-ink min-w-0 flex-1 truncate text-left text-sm focus-visible:outline-none"
                  >
                    {s.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${s.name}`}
                    onClick={() => void rename(s)}
                    className="text-ink-disabled hover:bg-bg-subtle hover:text-ink rounded p-1"
                  >
                    <PenLine className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => del(s)}
                    className="text-ink-disabled hover:bg-tint-error hover:text-state-error rounded p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => void createNew()}
              disabled={add.isPending}
            >
              <Plus className="h-4 w-4" />
              Create new
            </Button>
          </div>

          {/* Editor for the selected signature */}
          <div className="min-w-0 space-y-2">
            {selected ? (
              <>
                <MailEditor
                  initialHtml={selected.html}
                  resetKey={`sig-${selected.id}`}
                  onChange={(next) => {
                    htmlRef.current = next.html;
                  }}
                  placeholder="Regards, …"
                />
                <div className="flex justify-end">
                  <Button type="button" size="sm" onClick={saveHtml} disabled={updateSig.isPending}>
                    {updateSig.isPending ? 'Saving…' : 'Save signature'}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {signatures.length > 0 ? (
        <div className="mt-4 space-y-3">
          <p className="text-ink-muted text-xs font-semibold uppercase tracking-wide">
            Signature defaults
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-ink-muted block text-xs">
              For new emails use
              <select
                value={account.newSignatureId ?? ''}
                onChange={(e) => setDefault('newSignatureId', e.target.value)}
                className="border-line bg-bg-surface text-ink focus-visible:shadow-focus mt-1 block w-full rounded-md border px-2 py-1.5 text-sm focus-visible:outline-none"
              >
                <option value="">No signature</option>
                {signatures.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-ink-muted block text-xs">
              On reply/forward use
              <select
                value={account.replySignatureId ?? ''}
                onChange={(e) => setDefault('replySignatureId', e.target.value)}
                className="border-line bg-bg-surface text-ink focus-visible:shadow-focus mt-1 block w-full rounded-md border px-2 py-1.5 text-sm focus-visible:outline-none"
              >
                <option value="">No signature</option>
                {signatures.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="text-ink-muted flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={account.signatureBeforeQuote}
              onChange={(e) =>
                updateAccount.mutate({
                  id: account.id,
                  input: { signatureBeforeQuote: e.target.checked },
                })
              }
              className="mt-0.5"
            />
            Insert the signature above the quoted text in replies.
          </label>
        </div>
      ) : null}
    </section>
  );
}

function StatusBadge({ status }: { status: MailAccountStatus }) {
  if (status === 'ACTIVE') {
    return (
      <Tooltip content="Mailbox is verified and ready">
        <Badge tone="success" className="shrink-0">
          <CheckCircle2 className="h-3 w-3" /> Active
        </Badge>
      </Tooltip>
    );
  }
  if (status === 'CONNECTING') {
    return (
      <Badge tone="info" className="shrink-0">
        <Loader2 className="h-3 w-3 animate-spin" /> Verifying
      </Badge>
    );
  }
  if (status === 'AUTH_FAILED') {
    return (
      <Tooltip content="Login was rejected. Check the password.">
        <Badge tone="danger" className="shrink-0">
          <AlertCircle className="h-3 w-3" /> Login failed
        </Badge>
      </Tooltip>
    );
  }
  if (status === 'CONNECTION_FAILED') {
    return (
      <Tooltip content="Couldn't reach the mail server.">
        <Badge tone="warning" className="shrink-0">
          <AlertCircle className="h-3 w-3" /> Unreachable
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Badge tone="neutral" className="shrink-0">
      Disabled
    </Badge>
  );
}

function MenuItem({
  onClick,
  disabled,
  tone = 'default',
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
        tone === 'danger' ? 'text-state-error hover:bg-tint-error' : 'text-ink hover:bg-bg-subtle',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}
