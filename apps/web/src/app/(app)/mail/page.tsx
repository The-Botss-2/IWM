'use client';

import {
  ChevronLeft,
  FolderOpen,
  Loader2,
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Sparkles,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MailFolder, MailMessage } from '@botss/shared-types';

import type { ComposePrefill } from '@/components/mail/compose-mail-dialog';
import { FolderList } from '@/components/mail/folder-list';
import { NavPanelPortal, useNavPanelAvailable } from '@/components/shell/nav-panel-slot';
import { MessageList } from '@/components/mail/message-list';
import { MessageReader } from '@/components/mail/message-reader';
import { SelfSetupMailboxDialog } from '@/components/mail/self-setup-mailbox-dialog';
import { useSessionContext } from '@/components/auth/session-gate';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useMailAccounts } from '@/hooks/use-mail-accounts';
import { useHasOpened } from '@/hooks/use-has-opened';
import { useMailEvents } from '@/hooks/use-mail-events';
import { useMailFolders, useMailMessage } from '@/hooks/use-mail';
import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

// The compose dialog (rich editor, attachments, recipient suggestions) is
// loaded on first open instead of with the inbox.
const ComposeMailDialog = dynamic(
  () =>
    import('@/components/mail/compose-mail-dialog').then((m) => ({
      default: m.ComposeMailDialog,
    })),
  { ssr: false },
);

// Domain of mailboxes the server auto-provisions for. Mirrors CPANEL_DOMAIN
// on the API; set as NEXT_PUBLIC_CPANEL_DOMAIN at build time.
const ROOT_ORG_ID = 'org_root_thebotss';
// Empty when unset: then no one is offered self-serve mailbox setup.
const CPANEL_DOMAIN = (process.env.NEXT_PUBLIC_CPANEL_DOMAIN ?? '').trim().toLowerCase();

// Friendly folder labels for the phone "Folders" button. Mirrors the
// sidebar's ROLE_LABELS in folder-list.tsx so canonical folders read the
// same in both surfaces.
const FOLDER_ROLE_LABELS: Record<NonNullable<MailFolder['role']>, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  DRAFTS: 'Drafts',
  TRASH: 'Trash',
  SPAM: 'Spam',
  ARCHIVE: 'Archive',
  OUTBOX: 'Outbox',
  ALL: 'All mail',
  FLAGGED: 'Starred',
  IMPORTANT: 'Important',
};

/**
 * Full-screen mail client. Three-pane on desktop, single-pane stack on
 * mobile (folders → list → reader). Selection state is held here at the
 * page level so future deep links (?account=, ?folder=, ?msg=) can be wired
 * without restructuring.
 */
export default function MailPage() {
  const session = useSessionContext();
  const accounts = useMailAccounts();
  const items = accounts.data?.items ?? [];
  const activeAccounts = items.filter((a) => a.status === 'ACTIVE');
  const connectingAccounts = items.filter((a) => a.status === 'CONNECTING');

  const userEmail = (session.data?.user?.email ?? '').toLowerCase();
  // The cPanel server is the platform's: only root-org users can self-set up.
  const isOnCpanelDomain =
    !!CPANEL_DOMAIN &&
    session.data?.user?.organizationId === ROOT_ORG_ID &&
    userEmail.endsWith(`@${CPANEL_DOMAIN}`);
  const [selfSetupOpen, setSelfSetupOpen] = useState(false);

  // Subscribe to push events from the IDLE watcher so new mail appears
  // within seconds of arriving on the server instead of waiting for the
  // 30s polling tick.
  useMailEvents(activeAccounts.length > 0);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const composeMounted = useHasOpened(composeOpen);
  const [prefill, setPrefill] = useState<ComposePrefill | null>(null);
  // Phone-only folder drawer. The folder column is `hidden md:flex`, so below
  // md this overlay is the only way to switch folders. md+ is unaffected.
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  // Folder-sidebar collapse, persisted to localStorage so the choice survives
  // reloads and tab switches. Read in an effect so SSR doesn't see a value
  // that differs from the client's first paint.
  const [folderSidebarCollapsed, setFolderSidebarCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setFolderSidebarCollapsed(window.localStorage.getItem('mail.folderSidebar.collapsed') === '1');
  }, []);
  const toggleFolderSidebar = useCallback(() => {
    setFolderSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('mail.folderSidebar.collapsed', next ? '1' : '0');
      }
      return next;
    });
  }, []);

  // Deep link: /mail?msg=<id> (search results, notifications) opens that
  // message in its own account and folder. Read from the URL once on mount.
  const [linkedMessageId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('msg'),
  );
  const linkedMessage = useMailMessage(linkedMessageId);
  const linkApplied = useRef(false);
  useEffect(() => {
    if (linkApplied.current || !linkedMessage.data) return;
    linkApplied.current = true;
    setSelectedAccountId(linkedMessage.data.accountId);
    setSelectedFolderId(linkedMessage.data.folderId);
    setSelectedMessageId(linkedMessage.data.id);
  }, [linkedMessage.data]);

  // Pick the first active account once the list loads.
  useEffect(() => {
    if (linkedMessageId && !linkApplied.current) return;
    if (!selectedAccountId && activeAccounts.length > 0) {
      setSelectedAccountId(activeAccounts[0]!.id);
    }
  }, [activeAccounts, selectedAccountId, linkedMessageId]);

  // Under the rail layout the contextual panel becomes the folder list, so
  // the in-page folder column is dropped rather than duplicated. Under the
  // top bar there is no panel and the column stays exactly as it was.
  const inNavPanel = useNavPanelAvailable();

  const folders = useMailFolders(selectedAccountId);
  // Memoize so this reference is stable across renders. Without useMemo the
  // useEffect below would see a new `folderItems` array each render and
  // bounce between Inbox and "no folder selected" while folders load.
  const folderItems = useMemo(() => folders.data?.items ?? [], [folders.data]);

  // Default to INBOX once folders load. Sync is implicit on every
  // listMessages call (background, debounced 30 s) - no manual button.
  useEffect(() => {
    if (!selectedFolderId && folderItems.length > 0) {
      const inbox = folderItems.find((f) => f.role === 'INBOX') ?? folderItems[0]!;
      setSelectedFolderId(inbox.id);
    }
  }, [folderItems, selectedFolderId]);

  const selectedAccount = useMemo(
    () => activeAccounts.find((a) => a.id === selectedAccountId) ?? null,
    [activeAccounts, selectedAccountId],
  );

  const composeFromLabel = selectedAccount
    ? selectedAccount.displayName
      ? `${selectedAccount.displayName} <${selectedAccount.email}>`
      : selectedAccount.email
    : '';

  const openCompose = useCallback((next: ComposePrefill | null) => {
    setPrefill(next);
    setComposeOpen(true);
  }, []);

  const selectedFolder = useMemo(
    () => folderItems.find((f) => f.id === selectedFolderId) ?? null,
    [folderItems, selectedFolderId],
  );
  const isDraftsFolder = selectedFolder?.role === 'DRAFTS';
  // Friendly label for the phone "Folders" button, mirroring the sidebar's
  // role-based labels (raw IMAP names like "INBOX" otherwise leak through).
  const selectedFolderLabel = selectedFolder
    ? selectedFolder.role
      ? FOLDER_ROLE_LABELS[selectedFolder.role]
      : selectedFolder.name
    : 'Folders';

  const openDraftInCompose = useCallback(
    async (messageId: string) => {
      try {
        const msg = await getApi().mail.getMessage(messageId);
        openCompose({
          to: msg.toAddresses.join(', '),
          cc: msg.ccAddresses.join(', '),
          subject: msg.subject,
          body: msg.bodyText ?? '',
          ...(msg.bodyHtml ? { bodyHtml: msg.bodyHtml } : {}),
          draftMessageId: msg.id,
        });
      } catch (err) {
        toastError(err, "Couldn't open draft");
      }
    },
    [openCompose],
  );

  const onReply = useCallback(
    (message: MailMessage) => {
      const subjectPrefix = /^re:/i.test(message.subject) ? '' : 'Re: ';
      const quoted = quoteBody(message);
      openCompose({
        to: message.replyTo ?? message.fromAddress,
        subject: `${subjectPrefix}${message.subject}`,
        body: `\n\n${quoted}`,
        inReplyToMessageId: message.id,
        isReply: true,
      });
    },
    [openCompose],
  );

  // Capture the active account's email in a ref so reply-all's closure stays
  // stable across renders. Reading it inside the callback at call time gives
  // us the up-to-date value without putting `selectedAccount` in deps (which
  // would re-allocate the callback on every account switch).
  const selfEmail = selectedAccount?.email.toLowerCase() ?? '';
  const onReplyAll = useCallback(
    (message: MailMessage) => {
      const subjectPrefix = /^re:/i.test(message.subject) ? '' : 'Re: ';
      const quoted = quoteBody(message);
      const primary = message.replyTo ?? message.fromAddress;
      const others = [...message.toAddresses, ...message.ccAddresses].filter((addr) => {
        const lc = addr.toLowerCase().trim();
        return lc && lc !== selfEmail && lc !== primary.toLowerCase();
      });
      const ccSet = Array.from(new Set(others));
      openCompose({
        to: primary,
        ...(ccSet.length > 0 ? { cc: ccSet.join(', ') } : {}),
        subject: `${subjectPrefix}${message.subject}`,
        body: `\n\n${quoted}`,
        inReplyToMessageId: message.id,
        isReply: true,
      });
    },
    [openCompose, selfEmail],
  );

  const onForward = useCallback(
    (message: MailMessage) => {
      const subjectPrefix = /^fwd?:/i.test(message.subject) ? '' : 'Fwd: ';
      const quoted = quoteBody(message);
      openCompose({
        subject: `${subjectPrefix}${message.subject}`,
        body: `\n\n---------- Forwarded message ----------\n${quoted}`,
        isReply: true,
      });
    },
    [openCompose],
  );

  const onAfterMove = useCallback(() => {
    // Clear the reader pane so the user isn't left looking at a row that's
    // no longer in the current folder.
    setSelectedMessageId(null);
  }, []);

  // Close (deselect) the open message so the reader returns to its empty
  // state. Wired to the reader's Close button and the list row's right-click
  // "Close", mirroring closing an open chat.
  const onCloseReader = useCallback(() => {
    setSelectedMessageId(null);
  }, []);

  const onListSelect = useCallback(
    (id: string) => {
      if (isDraftsFolder) {
        void openDraftInCompose(id);
      } else {
        setSelectedMessageId(id);
      }
    },
    [isDraftsFolder, openDraftInCompose],
  );

  const onFolderSelect = useCallback((id: string) => {
    setSelectedFolderId(id);
    setSelectedMessageId(null);
    // Close the phone drawer after a pick; no-op on md+ where it's never open.
    setMobileFoldersOpen(false);
  }, []);

  const onComposeClick = useCallback(() => openCompose(null), [openCompose]);

  if (accounts.isLoading) {
    return (
      <PageLoader label="Loading mail" className="min-h-[var(--app-content-h,calc(100vh-4rem))]" />
    );
  }

  if (accounts.isError && !accounts.data) {
    return (
      <div className="p-4">
        <QueryError
          message="Couldn't load mail accounts."
          onRetry={() => void accounts.refetch()}
        />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <>
        <EmptyAccountsState
          isOnCpanelDomain={isOnCpanelDomain}
          onSelfSetup={() => setSelfSetupOpen(true)}
        />
        {isOnCpanelDomain ? (
          <SelfSetupMailboxDialog
            open={selfSetupOpen}
            onOpenChange={setSelfSetupOpen}
            email={userEmail}
          />
        ) : null}
      </>
    );
  }

  if (activeAccounts.length === 0) {
    // If anything is in CONNECTING the auto-provision is mid-flight; tell the
    // user it's happening rather than nudging them to "check settings".
    const stillConnecting = connectingAccounts.length > 0;
    return (
      <AccountNotReadyState stillConnecting={stillConnecting} isOnCpanelDomain={isOnCpanelDomain} />
    );
  }

  const folderPane = (
    <>
      <div className="border-line flex items-center justify-between border-b px-2 py-2">
        {!folderSidebarCollapsed || inNavPanel ? (
          <span className="text-ink-muted px-2 text-xs font-semibold uppercase tracking-wide">
            Mail
          </span>
        ) : (
          <span className="sr-only">Mail</span>
        )}
        {/* Close affordance on phone; collapse toggle on md+. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close folders"
          onClick={() => setMobileFoldersOpen(false)}
          className="text-ink-muted hover:text-ink h-7 min-h-0 w-7 min-w-0 md:hidden"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
        {/* In the nav panel the rail already owns a collapse control, so a
            second one here would be two toggles for one column. */}
        {inNavPanel ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={folderSidebarCollapsed ? 'Expand folder list' : 'Collapse folder list'}
            onClick={toggleFolderSidebar}
            className="text-ink-muted hover:text-ink hidden h-7 min-h-0 w-7 min-w-0 md:inline-flex"
          >
            {folderSidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            )}
          </Button>
        )}
      </div>
      <FolderList
        folders={folderItems}
        selectedId={selectedFolderId}
        onSelect={onFolderSelect}
        onCompose={onComposeClick}
        composeDisabled={!selectedAccount}
        collapsed={inNavPanel ? false : folderSidebarCollapsed}
      />
    </>
  );

  return (
    <div
      className={cn(
        'grid h-[var(--app-content-h,calc(100vh-4rem))] grid-cols-1 overflow-hidden',
        // Folder column width drives the grid template at md/lg. Collapsed
        // is 52px (icon strip), expanded is 220px (full labels). The third
        // (reader) column only appears at lg, matching the prior layout.
        //
        // When the folder list lives in the rail's contextual panel there is
        // no folder column here at all - keeping one would show the folders
        // twice, side by side, which is what this replaced.
        inNavPanel
          ? 'md:grid-cols-[minmax(0,1fr)] lg:grid-cols-[380px_minmax(0,1fr)]'
          : folderSidebarCollapsed
            ? 'md:grid-cols-[52px_minmax(0,1fr)] lg:grid-cols-[52px_380px_minmax(0,1fr)]'
            : 'md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[220px_380px_minmax(0,1fr)]',
      )}
    >
      {/* Below md the folder column is a slide-in overlay drawer (the grid
          column itself is hidden there); a backdrop dims the rest. At md+ the
          drawer classes are overridden so it renders as the static grid
          column exactly as before. */}
      {mobileFoldersOpen ? (
        <button
          type="button"
          aria-label="Close folders"
          onClick={() => setMobileFoldersOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}
      {inNavPanel ? (
        <NavPanelPortal>{folderPane}</NavPanelPortal>
      ) : (
        <aside
          className={cn(
            'border-line min-h-0 overflow-hidden border-r bg-white md:flex md:flex-col',
            // Phone: fixed off-canvas drawer, slides in when open.
            'shadow-soft-lg fixed inset-y-0 left-0 z-40 flex w-[260px] max-w-[80%] flex-col transition-transform duration-200 md:static md:z-auto md:w-auto md:max-w-none md:shadow-none md:transition-none',
            mobileFoldersOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          )}
        >
          {folderPane}
        </aside>
      )}

      {/* Below md, only one column renders at a time: list when no message
          is selected, reader once the user opens one. Above md the grid
          shows both, so the explicit visibility rules here only affect
          the single-column case. */}
      <section
        className={cn(
          'border-line bg-bg-app min-h-0 flex-col overflow-hidden border-r md:flex',
          selectedMessageId ? 'hidden md:flex' : 'flex',
        )}
        aria-label="Message list"
      >
        {/* Phone-only bar to open the folder drawer. The folder column is
            hidden below md, so without this there's no way to switch folders
            on a phone. Hidden at md+ where the folder column is visible. */}
        <div className="border-line flex items-center gap-2 border-b bg-white px-3 py-2 md:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMobileFoldersOpen(true)}
            className="text-ink-muted hover:text-ink h-8 px-2 text-sm"
          >
            <FolderOpen className="h-4 w-4" aria-hidden />
            {selectedFolderLabel}
          </Button>
        </div>
        {selectedAccountId ? (
          <MessageList
            accountId={selectedAccountId}
            folderId={selectedFolderId}
            folder={selectedFolder}
            selectedMessageId={selectedMessageId}
            onSelect={onListSelect}
            onAfterBulkAction={onAfterMove}
            onClose={onCloseReader}
          />
        ) : (
          <div className="text-ink-muted grid flex-1 place-items-center text-xs">
            Pick an account.
          </div>
        )}
      </section>

      <section
        className={cn(
          'min-h-0 flex-col overflow-hidden lg:flex',
          // Reader shows below md only when a message is open (so the list
          // stays the default landing surface on mobile); md sits in
          // between with no reader column, so we always hide it there.
          selectedMessageId ? 'flex md:hidden lg:flex' : 'hidden lg:flex',
        )}
        aria-label="Reading pane"
      >
        {/* Back arrow only renders below md; the multi-pane layout doesn't
            need it. Clicking clears `selectedMessageId` which makes the
            list re-appear via the `hidden md:flex` toggle above. */}
        {selectedMessageId ? (
          <button
            type="button"
            onClick={() => setSelectedMessageId(null)}
            className="border-line text-ink-muted hover:text-ink inline-flex items-center gap-2 border-b bg-white px-4 py-2 text-sm md:hidden"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Back to list
          </button>
        ) : null}
        <MessageReader
          messageId={selectedMessageId}
          currentFolderRole={selectedFolder?.role ?? null}
          onReply={onReply}
          onReplyAll={onReplyAll}
          onForward={onForward}
          onAfterMove={onAfterMove}
          onClose={onCloseReader}
        />
      </section>

      {selectedAccount && composeMounted ? (
        <ComposeMailDialog
          open={composeOpen}
          onOpenChange={setComposeOpen}
          accountId={selectedAccount.id}
          fromLabel={composeFromLabel}
          prefill={prefill}
        />
      ) : null}
    </div>
  );
}

/** No MailAccount at all. cPanel-domain users get a one-click self-setup;
 *  external users follow the manual flow in /settings/mail. */
function EmptyAccountsState({
  isOnCpanelDomain,
  onSelfSetup,
}: {
  isOnCpanelDomain: boolean;
  onSelfSetup: () => void;
}) {
  if (isOnCpanelDomain) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <span className="bg-brand-gradient shadow-soft mx-auto grid h-14 w-14 place-items-center rounded-full text-white">
          <Sparkles className="h-6 w-6" aria-hidden />
        </span>
        <h2 className="text-ink mt-4 text-lg font-semibold">Set up your mailbox in one click</h2>
        <p className="text-ink-muted mt-1 text-sm">
          We&apos;ll provision your inbox automatically. Just choose a password for both this app
          and your webmail - no IMAP or SMTP details to copy.
        </p>
        <Button className="mt-4" onClick={onSelfSetup}>
          <Sparkles className="h-4 w-4" />
          Set up my mailbox
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <span className="bg-brand-50 text-brand-700 mx-auto grid h-14 w-14 place-items-center rounded-full">
        <Mail className="h-6 w-6" aria-hidden />
      </span>
      <h2 className="text-ink mt-4 text-lg font-semibold">Connect a mailbox to start</h2>
      <p className="text-ink-muted mt-1 text-sm">
        Add your IMAP and SMTP credentials in settings. Once verified, you can read and send mail
        from inside the app.
      </p>
      <Link
        href="/settings/mail"
        className="bg-brand-gradient shadow-soft hover:shadow-soft-lg focus-visible:shadow-focus mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-white transition-all focus-visible:outline-none"
      >
        <Pencil className="h-4 w-4" />
        Go to Mail accounts
      </Link>
    </div>
  );
}

/** MailAccount exists but isn't ACTIVE yet. The CONNECTING case is the
 *  common path immediately after admin user-create or self-setup - the
 *  verify-account BullMQ job is running and the account flips to ACTIVE
 *  within a few seconds. The polling in `useMailAccounts` handles the
 *  refresh automatically, so we just need to set expectations. */
function AccountNotReadyState({
  stillConnecting,
  isOnCpanelDomain,
}: {
  stillConnecting: boolean;
  isOnCpanelDomain: boolean;
}) {
  if (stillConnecting) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <span className="bg-brand-gradient shadow-soft mx-auto grid h-14 w-14 place-items-center rounded-full text-white">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </span>
        <h2 className="text-ink mt-4 text-lg font-semibold">Setting up your mailbox…</h2>
        <p className="text-ink-muted mt-1 text-sm">
          Connecting to your mail server. This usually takes just a few seconds. Your inbox will
          appear here as soon as the connection is verified.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <span className="bg-tint-warning text-brand-orange mx-auto grid h-14 w-14 place-items-center rounded-full">
        <Mail className="h-6 w-6" aria-hidden />
      </span>
      <h2 className="text-ink mt-4 text-lg font-semibold">Mailbox connection failed</h2>
      <p className="text-ink-muted mt-1 text-sm">
        {isOnCpanelDomain
          ? 'Your mailbox is configured but the mail server rejected the credentials. Reset your password from Mail accounts to fix this.'
          : 'Your mail server rejected the saved credentials. Open Mail accounts to update the password or settings.'}
      </p>
      <Link
        href="/settings/mail"
        className="bg-brand-gradient shadow-soft hover:shadow-soft-lg focus-visible:shadow-focus mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-white transition-all focus-visible:outline-none"
      >
        Open mail accounts
      </Link>
    </div>
  );
}

function quoteBody(message: MailMessage): string {
  const sender = message.fromName?.trim()
    ? `${message.fromName} <${message.fromAddress}>`
    : message.fromAddress;
  const date = new Date(message.receivedAt).toLocaleString();
  const text = message.bodyText ?? '';
  const lines = text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `On ${date}, ${sender} wrote:\n${lines}`;
}
