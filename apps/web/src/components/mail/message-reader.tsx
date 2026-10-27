'use client';

import {
  Archive,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Forward,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { MailAttachment, MailFolderRole, MailMessage } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  useDownloadMailAttachment,
  useFlagMessage,
  useMailMessage,
  useMoveMailMessage,
} from '@/hooks/use-mail';
import { env } from '@/lib/env';
import { mailFrameCsp, prepareMailHtml } from '@/lib/mail-html';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Props {
  messageId: string | null;
  /** Role of the folder the user is currently viewing. Controls which move
   *  actions are surfaced (e.g. "Not spam" only appears inside Spam). */
  currentFolderRole?: MailFolderRole | null;
  onReply: (message: MailMessage) => void;
  onReplyAll: (message: MailMessage) => void;
  onForward: (message: MailMessage) => void;
  onAfterMove?: () => void;
  /** Close (deselect) the open message so the reader returns to its empty
   *  "select a message" state. Mirrors closing an open chat. */
  onClose?: () => void;
}

/**
 * Reading pane. Renders the sanitized HTML body inside a sandboxed iframe
 * so even a sanitizer bypass can't reach the parent. Marks the message read
 * on open. Plain-text fallback when no HTML body is present.
 */
export function MessageReader({
  messageId,
  currentFolderRole,
  onReply,
  onReplyAll,
  onForward,
  onAfterMove,
  onClose,
}: Props) {
  const { data, isLoading, isError, refetch } = useMailMessage(messageId);
  const flag = useFlagMessage();
  const move = useMoveMailMessage();
  const inSpam = currentFolderRole === 'SPAM';

  async function moveTo(role: 'ARCHIVE' | 'TRASH' | 'SPAM' | 'INBOX') {
    if (!data) return;
    try {
      await move.mutateAsync({ id: data.id, target: { role } });
      toast.success(
        role === 'ARCHIVE'
          ? 'Archived.'
          : role === 'TRASH'
            ? 'Moved to Trash.'
            : role === 'SPAM'
              ? 'Marked as spam.'
              : 'Moved to Inbox.',
      );
      onAfterMove?.();
    } catch {
      // toast already shown by the hook's onError
    }
  }

  // Auto-mark-read when a message is opened. Server flips the IMAP \Seen
  // flag so other clients reflect the same state.
  useEffect(() => {
    if (data && data.isUnread) {
      flag.mutate({ id: data.id, op: 'read' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id]);

  if (!messageId) {
    return (
      <div className="flex h-full items-center justify-center bg-bg-subtle px-6">
        <div className="text-center text-sm text-ink-muted">
          <Mail className="mx-auto h-10 w-10 text-line-strong" aria-hidden />
          <p className="mt-3">Select a message to read.</p>
        </div>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg-subtle px-6">
        <QueryError compact message="Couldn't load this message." onRetry={() => void refetch()} />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg-subtle px-6">
        <Loader label="Loading message" />
      </div>
    );
  }

  const sender = data.fromName?.trim() || data.fromAddress;

  return (
    // Below lg the reader is a single full-screen pane: the whole thing
    // (header + body + attachments) scrolls as one so the metadata/action
    // header slides up off-screen with the email instead of staying pinned
    // and eating the viewport. At lg+ we keep the tuned 3-zone layout - a
    // fixed header, an internally-scrolling body, and a pinned attachments
    // strip - because there's room for it.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-white lg:overflow-hidden">
      <header className="border-b border-line p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-ink">
              {data.subject || '(no subject)'}
            </h2>
            <div className="mt-1 truncate text-sm text-ink">
              <span className="font-medium">{sender}</span>
              {data.fromName ? (
                <span className="ml-1 text-ink-muted">&lt;{data.fromAddress}&gt;</span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-xs text-ink-muted">
              To {data.toAddresses.join(', ') || 'undisclosed'}
              {data.ccAddresses.length > 0 ? (
                <>
                  <span className="mx-1.5 text-line-strong">·</span>
                  Cc {data.ccAddresses.join(', ')}
                </>
              ) : null}
            </div>
            <div
              className="mt-0.5 truncate text-xs text-ink-muted"
              title={absoluteTime(data.receivedAt)}
            >
              {absoluteTime(data.receivedAt)} ({relativeTime(data.receivedAt)})
            </div>
          </div>
          {/* Single horizontal row that scrolls sideways on a narrow screen
              instead of wrapping into a tall multi-row block. */}
          <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 sm:mx-0 sm:shrink-0 sm:justify-end sm:overflow-visible sm:px-0">
            <Button
              size="sm"
              variant="ghost"
              aria-label={data.isStarred ? 'Unstar' : 'Star'}
              onClick={() =>
                flag.mutate({ id: data.id, op: data.isStarred ? 'unstar' : 'star' })
              }
              className={cn(data.isStarred && 'text-amber-500')}
            >
              <Star className="h-4 w-4" fill={data.isStarred ? 'currentColor' : 'none'} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Archive"
              onClick={() => moveTo('ARCHIVE')}
              disabled={move.isPending}
            >
              <Archive className="h-4 w-4" />
            </Button>
            {inSpam ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Not spam"
                title="Not spam - move to Inbox"
                onClick={() => moveTo('INBOX')}
                disabled={move.isPending}
              >
                <Inbox className="h-4 w-4" />
                Not spam
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Mark as spam"
                onClick={() => moveTo('SPAM')}
                disabled={move.isPending}
              >
                <ShieldAlert className="h-4 w-4" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label="Delete"
              onClick={() => moveTo('TRASH')}
              disabled={move.isPending}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Reply" onClick={() => onReply(data)}>
              <Reply className="h-4 w-4" />
              Reply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Reply all"
              onClick={() => onReplyAll(data)}
              disabled={data.toAddresses.length + data.ccAddresses.length <= 1}
            >
              <ReplyAll className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Forward" onClick={() => onForward(data)}>
              <Forward className="h-4 w-4" />
            </Button>
            {onClose ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close"
                title="Close this message"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {/*
       * At lg+ the body fills the room left between the pinned header and
       * the attachments strip and scrolls internally (iframe gets h-full so
       * a one-line email doesn't force empty space). Below lg there's no
       * flex-1/overflow here - the whole reader scrolls as one, so the body
       * sits in normal flow and the header above it scrolls away.
       */}
      <div className="p-4 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
        {data.bodyHtml && data.bodyHtml.trim().length > 0 ? (
          <SandboxedBody
            key={data.id}
            html={data.bodyHtml}
            messageId={data.id}
            attachments={data.attachments}
          />
        ) : (
          <PlainTextBody text={data.bodyText ?? ''} />
        )}
      </div>

      <AttachmentsStrip messageId={data.id} attachments={data.attachments} />
    </div>
  );
}

/**
 * Gmail-style attachment cards. Inline attachments (cid: references embedded
 * in the HTML body) are filtered out - they render inside the message itself
 * and would just be noise here. The whole card is a download link; a hover
 * overlay surfaces an explicit download icon for users who don't realise the
 * card is clickable.
 */
function AttachmentsStrip({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: readonly MailAttachment[];
}) {
  const visible = useMemo(
    () => attachments.filter((a) => !a.isInline),
    [attachments],
  );
  if (visible.length === 0) return null;
  return (
    // Pinned outside the body scroll so they're always visible without
    // scrolling past the message. shrink-0 keeps them from being squeezed
    // when the body iframe takes its share of the column.
    <section className="shrink-0 border-t border-line p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        <Paperclip className="h-3 w-3" />
        {visible.length} {visible.length === 1 ? 'attachment' : 'attachments'}
      </h3>
      <ul className="flex flex-wrap gap-3" role="list">
        {visible.map((a) => (
          <li key={a.id} className="w-full sm:w-auto">
            <AttachmentCard messageId={messageId} attachment={a} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttachmentCard({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: MailAttachment;
}) {
  // Absolute URL to the API origin - a relative path would resolve against the
  // web origin and hit the Next.js 404 page instead of the NestJS controller.
  // Used ONLY as an <img src> thumbnail (a subresource load, which still
  // carries the shared-domain session cookie). Downloads deliberately do NOT
  // link at this URL: see `useDownloadMailAttachment`.
  const thumbnailSrc = `${env.apiUrl}${env.apiBasePath}/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`;
  const { Icon, color } = pickAttachmentIcon(attachment.contentType, attachment.filename);
  const isImage = attachment.contentType.startsWith('image/');
  const ext = extOf(attachment.filename);
  const download = useDownloadMailAttachment();
  const isDownloading = download.isPending;

  return (
    <button
      type="button"
      disabled={isDownloading}
      onClick={() =>
        download.mutate({
          messageId,
          attachmentId: attachment.id,
          filename: attachment.filename,
        })
      }
      title={`Download ${attachment.filename}`}
      className={cn(
        'group relative flex h-16 w-full items-center gap-3 overflow-hidden rounded-lg border border-line bg-white px-3 text-left sm:w-[260px]',
        'transition-all duration-200 hover:border-line-strong hover:shadow-soft',
        'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-brand-purple',
        isDownloading && 'cursor-progress opacity-70',
      )}
    >
      {/* Icon / image thumbnail */}
      <div
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md',
          isImage ? 'bg-bg-subtle' : color.bg,
        )}
      >
        {isImage ? (
          // Loading the image directly from the attachment endpoint gives us
          // a free thumbnail. This is a subresource load, not a navigation, so
          // the shared-domain session cookie rides along. next/image is the
          // wrong tool here: the endpoint is session-authenticated and the
          // Next loader would proxy through an unauthenticated optimizer.
          // Failed loads fall back to the file-image icon via onError.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailSrc}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(e) => {
              const target = e.currentTarget;
              target.style.display = 'none';
              const fallback = target.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = 'flex';
            }}
          />
        ) : null}
        <Icon
          className={cn('h-5 w-5', color.fg, isImage && 'hidden')}
          aria-hidden
        />
      </div>

      {/* Filename + meta */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">
          {attachment.filename}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
          {ext ? <span className="uppercase">{ext}</span> : null}
          {ext ? <span className="text-line-strong">·</span> : null}
          <span>{formatBytes(attachment.sizeBytes)}</span>
        </div>
      </div>

      {/* Hover-revealed download chip in the top-right corner. Pinned visible
          while the fetch is in flight so the click has visible feedback - the
          bytes come from IMAP, which can take a second or two. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-brand-gradient text-white shadow-soft',
          'transition-all duration-200',
          isDownloading
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0',
        )}
      >
        {isDownloading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
      </span>
    </button>
  );
}

const ICON_BY_KIND: Record<
  string,
  { Icon: LucideIcon; color: { bg: string; fg: string } }
> = {
  image:       { Icon: FileImage,       color: { bg: 'bg-tint-warning', fg: 'text-brand-orange' } },
  pdf:         { Icon: FileText,        color: { bg: 'bg-tint-error', fg: 'text-state-error' } },
  word:        { Icon: FileText,        color: { bg: 'bg-[#EAF0FC]', fg: 'text-brand-blue' } },
  spreadsheet: { Icon: FileSpreadsheet, color: { bg: 'bg-tint-info', fg: 'text-brand-teal' } },
  slides:      { Icon: FileText,        color: { bg: 'bg-tint-warning', fg: 'text-brand-orange' } },
  audio:       { Icon: FileAudio,       color: { bg: 'bg-[#FAEBFE]', fg: 'text-brand-magenta' } },
  video:       { Icon: FileVideo,       color: { bg: 'bg-[#EAF0FC]', fg: 'text-brand-blue' } },
  archive:     { Icon: FileArchive,     color: { bg: 'bg-tint-warning', fg: 'text-brand-orange' } },
  text:        { Icon: FileText,        color: { bg: 'bg-bg-subtle', fg: 'text-ink-muted' } },
  default:     { Icon: FileIcon,        color: { bg: 'bg-bg-subtle', fg: 'text-ink-muted' } },
};

function pickAttachmentIcon(
  contentType: string,
  filename: string,
): { Icon: LucideIcon; color: { bg: string; fg: string } } {
  const ct = contentType.toLowerCase();
  const ext = extOf(filename).toLowerCase();
  if (ct.startsWith('image/')) return ICON_BY_KIND.image!;
  if (ct === 'application/pdf' || ext === 'pdf') return ICON_BY_KIND.pdf!;
  if (ct.startsWith('audio/')) return ICON_BY_KIND.audio!;
  if (ct.startsWith('video/')) return ICON_BY_KIND.video!;
  if (
    ct.includes('zip') ||
    ct.includes('rar') ||
    ct.includes('7z') ||
    ct.includes('tar') ||
    ct.includes('gzip') ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(ext)
  ) {
    return ICON_BY_KIND.archive!;
  }
  if (
    ct.includes('spreadsheet') ||
    ct.includes('excel') ||
    ct === 'text/csv' ||
    ['xls', 'xlsx', 'csv', 'ods'].includes(ext)
  ) {
    return ICON_BY_KIND.spreadsheet!;
  }
  if (
    ct.includes('presentation') ||
    ct.includes('powerpoint') ||
    ['ppt', 'pptx', 'odp', 'key'].includes(ext)
  ) {
    return ICON_BY_KIND.slides!;
  }
  if (
    ct.includes('word') ||
    ct.includes('msword') ||
    ct.includes('document') ||
    ['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)
  ) {
    return ICON_BY_KIND.word!;
  }
  if (ct.startsWith('text/')) return ICON_BY_KIND.text!;
  return ICON_BY_KIND.default!;
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  if (i <= 0 || i === filename.length - 1) return '';
  return filename.slice(i + 1);
}

// Static document shell used to wrap every message body. Pulled out of the
// component so the literal string is allocated once at module-load instead
// of on every render. We splice the body HTML in via useMemo on the call
// site so the iframe srcDoc only changes when the message (or theme)
// itself does.
//
// The CSS branches on a `body.theme-dark` class so the iframe respects the
// CRM's own theme toggle. Iframes don't inherit parent CSS, so without
// this every email body renders on a hard white surface even when the
// user has dark mode on across the rest of the app. We can't override
// inline styles from rich-HTML newsletters - their authors chose those
// colours - but plain-text + lightly-formatted messages now match the
// surrounding chrome.
const IFRAME_SHELL_HEAD_LIGHT = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="__CSP__" />
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<base target="_blank">
<style>
html,body { margin:0; padding:0; font: 14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:#1e293b; background:#ffffff; word-wrap:break-word; }
img { max-width: 100%; height: auto; }
a { color: #4f46e5; }
blockquote { border-left: 3px solid #e2e8f0; padding-left: 12px; color: #64748b; margin: 8px 0; }
pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head><body>`;
const IFRAME_SHELL_HEAD_DARK = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="__CSP__" />
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<base target="_blank">
<style>
html,body { margin:0; padding:0; font: 14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:#e2e8f0; background:#161924; word-wrap:break-word; color-scheme: dark; }
img { max-width: 100%; height: auto; }
a { color: #a5b4fc; }
blockquote { border-left: 3px solid #334155; padding-left: 12px; color: #94a3b8; margin: 8px 0; }
pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head><body>`;
const IFRAME_SHELL_TAIL = `</body></html>`;

/**
 * Read the current app theme from the root `<html>` class. Memoised inside
 * SandboxedBody so the iframe doesn't reload on unrelated re-renders.
 * Returns false on SSR (no document) since SSR'd messages don't render
 * the iframe anyway.
 */
function useIframeDarkMode(): boolean {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const compute = () =>
      document.documentElement.classList.contains('dark');
    setIsDark(compute());
    // Re-run when the ThemeMount toggles the dark class on <html>.
    const observer = new MutationObserver(() => setIsDark(compute()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

const SandboxedBody = memo(function SandboxedBody({
  html,
  messageId,
  attachments,
}: {
  html: string;
  messageId: string;
  attachments: MailAttachment[];
}) {
  // The HTML is rendered inside an iframe with `sandbox` set so a script
  // bypass cannot read the parent's cookies, run JS, or navigate the top
  // window. We do NOT include `allow-scripts`. `srcDoc` keeps the content
  // same-origin-free so cookies do not leak across iframe → parent.
  //
  // useMemo keeps the concatenated srcDoc identity stable across re-renders
  // when neither the message HTML nor the theme changed. Without it,
  // every parent state change rebuilds the string and React diffs it
  // against the DOM attr; identical text avoids a reload but the
  // allocation is still ~MBs per keystroke when the parent dialog is
  // updating.
  const isDark = useIframeDarkMode();
  // Remote images stay off until the user asks, per message.
  const [loadRemote, setLoadRemote] = useState(false);
  const apiOrigin = useMemo(() => {
    try {
      return new URL(env.apiUrl).origin;
    } catch {
      return '';
    }
  }, []);
  const prepared = useMemo(
    () =>
      prepareMailHtml(html, {
        attachments,
        loadRemote,
        attachmentUrl: (attachmentId) =>
          `${env.apiUrl}${env.apiBasePath}/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      }),
    [html, attachments, loadRemote, messageId],
  );
  const srcDoc = useMemo(() => {
    const head = (isDark ? IFRAME_SHELL_HEAD_DARK : IFRAME_SHELL_HEAD_LIGHT).replace(
      '__CSP__',
      mailFrameCsp(apiOrigin, loadRemote),
    );
    return `${head}${prepared.html}${IFRAME_SHELL_TAIL}`;
  }, [prepared.html, isDark, apiOrigin, loadRemote]);
  return (
    <div className="flex h-full flex-col">
      {prepared.blockedRemote > 0 && !loadRemote ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg-subtle px-3 py-2 text-xs text-ink-muted">
          <span>Remote images are hidden so the sender can&apos;t tell when you open this message.</span>
          <Button size="sm" variant="ghost" onClick={() => setLoadRemote(true)}>
            Show images
          </Button>
        </div>
      ) : null}
    <iframe
      title="Message body"
      // We deliberately do NOT include `allow-scripts` - message bodies are
      // untrusted. `allow-popups` + `allow-popups-to-escape-sandbox` lets
      // anchor tags with `target="_blank"` (set via the shell's `<base>`)
      // actually open a new tab; without these flags, the empty sandbox
      // silently swallows every link click. `allow-popups-to-escape-sandbox`
      // ensures the new tab does NOT inherit the iframe's restrictive
      // sandbox (otherwise the opened page would also be JS-disabled and
      // unable to render most modern sites).
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      // At lg+ the iframe fills the body slot and scrolls its own document.
      // Below lg the whole reader scrolls as one (so the header can slide
      // away), but a sandboxed iframe can't report its content height back
      // to size itself, so we give it a tall fixed viewport height and let
      // it scroll internally past that - the standard mobile-webmail
      // tradeoff.
      className="block h-[75vh] w-full border-0 lg:min-h-0 lg:flex-1"
    />
    </div>
  );
});

/**
 * Plain-text email body with URL + email auto-linkification. Plain-text
 * messages used to render inside a flat <pre>, which meant any link the
 * sender pasted in (signature footer, calendar invite, support URL) was
 * just text - clicking it did nothing. We tokenize the text into spans
 * and anchor tags so clicks open the URL in a new tab, while keeping
 * whitespace + line breaks intact via `whitespace-pre-wrap`.
 *
 * We DON'T render arbitrary HTML here: each token is either a literal
 * string segment or a known-shape anchor we built ourselves. No
 * `dangerouslySetInnerHTML` - safe even if the body contains markup-
 * looking characters.
 */
function PlainTextBody({ text }: { text: string }) {
  const tokens = useMemo(() => linkifyTokens(text), [text]);
  return (
    <div className="w-full whitespace-pre-wrap break-words font-sans text-sm leading-6 text-ink lg:h-full lg:overflow-y-auto">
      {tokens.map((tok, i) =>
        tok.kind === 'link' ? (
          <a
            key={i}
            href={tok.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-brand-700 underline hover:text-brand-800"
          >
            {tok.text}
          </a>
        ) : (
          // Index-keyed fragments are fine here - the token list is a pure
          // derivation of `text` (no reordering, no insert/remove without
          // a content change), so index identity is stable across renders.
          <span key={i}>{tok.text}</span>
        ),
      )}
    </div>
  );
}

// Matches http(s):// and bare www. URLs; also mailto-able email addresses.
// Greedy stop on whitespace/quotes/closing punctuation so trailing dots and
// commas in prose don't get sucked into the href.
const LINKIFY_RE =
  /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function linkifyTokens(text: string): { kind: 'text' | 'link'; text: string; href?: string }[] {
  const out: { kind: 'text' | 'link'; text: string; href?: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // Reset the regex's lastIndex in case the same compiled instance was used
  // for a previous body - RegExp objects are stateful with the /g flag.
  LINKIFY_RE.lastIndex = 0;
  while ((match = LINKIFY_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    // Strip trailing punctuation that we intentionally let into the match
    // because of the greedy URL pattern (closing parens / sentence-ending
    // periods often follow a link).
    let trimmed = raw;
    while (/[).,;:!?]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
    const href = isEmail
      ? `mailto:${trimmed}`
      : trimmed.startsWith('http')
        ? trimmed
        : `https://${trimmed}`;
    out.push({ kind: 'link', text: trimmed, href });
    if (trimmed.length < raw.length) {
      // Push the trailing punctuation back into the stream as plain text.
      out.push({ kind: 'text', text: raw.slice(trimmed.length) });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < text.length) {
    out.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
