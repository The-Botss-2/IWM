import { isCancelledError } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

/**
 * The app's single entry point for transient feedback. Never import `sonner`
 * directly - everything here scrubs secrets, de-duplicates identical toasts
 * and keeps durations consistent. The one `<Toaster />` lives in
 * `components/shell/app-toaster.tsx`.
 *
 * Errors, in order of preference:
 * - Mutation failed    -> `useMutation({ meta: { errorTitle: "Couldn't save invoice" } })`.
 *                         The global MutationCache handler in `lib/query-client.ts`
 *                         toasts the title plus the server's reason, unless a local
 *                         handler already reported it. Keep an `onError` only for
 *                         rollback, and toast from it with `toastError`.
 * - Caught error       -> `toastError(err, "Couldn't save invoice")` (try/catch,
 *                         per-call `mutate(x, { onError })`, callbacks).
 * - No error object    -> `toastErrorMessage("Couldn't copy the link")` (client-side
 *                         checks, or text a helper already worded).
 * - Shown inline       -> `getErrorMessage(err)` / `describeError(err, fallback)`, plus
 *                         `markErrorReported()` so the global handler stays quiet.
 * Wording: "Couldn't <verb> <thing>" - never "Failed to" / "Could not" (lint-enforced),
 * titles without a trailing period.
 *
 * Other feedback:
 * - Action succeeded   -> `toastSuccess('Invoice saved')` or `meta.successMessage`
 * - Neutral notice     -> `toastInfo('Copied to clipboard')`
 *
 * Field-level validation stays inline under the input (react-hook-form).
 */

const ERROR_DURATION_MS = 6_000;
const MAX_MESSAGE_LENGTH = 300;

/**
 * Monotonic count of error toasts shown. The global MutationCache handler
 * compares it before/after a failed mutation's own handlers run to tell
 * whether the call site already reported the error (no double toasts).
 */
let errorToastCount = 0;
export function getErrorToastCount(): number {
  return errorToastCount;
}

/**
 * Tell the global mutation-error handler that the current failure has been
 * reported some other way (inline error state, an aggregated summary toast
 * after a bulk operation, an intentional best-effort ignore). Call it
 * synchronously in the `catch` / `onError` that handles the failure.
 */
export function markErrorReported(): void {
  errorToastCount += 1;
}

function showError(
  title: string,
  opts: { description?: string; onRetry?: () => void } = {},
): void {
  errorToastCount += 1;
  const safeTitle = scrubSecrets(title);
  const description = opts.description ? scrubSecrets(opts.description) : undefined;
  sonnerToast.error(safeTitle, {
    // Same text -> same id, so a failing autosave or a burst of identical
    // failures updates one toast instead of stacking copies.
    id: `error:${safeTitle}:${description ?? ''}`,
    description,
    duration: ERROR_DURATION_MS,
    action: opts.onRetry ? { label: 'Retry', onClick: opts.onRetry } : undefined,
  });
}

/**
 * Legacy message-only API; prefer `toastSuccess` / `toastInfo` in new code.
 * There is deliberately no `toast.error`: errors go through `toastError`,
 * `toastErrorMessage` or a mutation's `meta.errorTitle` (lint also bans it).
 */
export const toast = {
  success: (msg: string) => toastSuccess(msg),
  info: (msg: string) => toastInfo(msg),
};

/** Show a success toast for a completed action (create/update/delete/send/...). */
export function toastSuccess(message: string, description?: string): void {
  const safe = scrubSecrets(message);
  sonnerToast.success(safe, {
    id: `success:${safe}`,
    description: description ? scrubSecrets(description) : undefined,
  });
}

/** Neutral informational toast ("Link copied", "Coming soon"). */
export function toastInfo(message: string, description?: string): void {
  const safe = scrubSecrets(message);
  sonnerToast(safe, {
    id: `info:${safe}`,
    description: description ? scrubSecrets(description) : undefined,
  });
}

/**
 * Show an error toast when there is no error object to describe - a client-side
 * check failed, or a helper already produced the final wording. Use
 * `toastError(err, title)` whenever an error value is available.
 */
export function toastErrorMessage(
  message: string,
  opts?: { description?: string; onRetry?: () => void },
): void {
  showError(message, { description: opts?.description, onRetry: opts?.onRetry });
}

/**
 * Show an error toast for a failed action. `fallbackTitle` is the headline
 * ("Couldn't delete client"); the specific reason extracted from the error
 * (RFC 7807 `detail`, validation errors, ...) becomes the description.
 * Aborted / cancelled requests are ignored.
 */
export function toastError(
  err: unknown,
  fallbackTitle: string,
  opts?: { onRetry?: () => void },
): void {
  if (isSilentError(err)) return;
  // Always give a reason: the server's words, a status based explanation, or
  // a generic line, so the user is never left with only "Couldn't do X".
  const message = getErrorMessage(err) ?? UNKNOWN_REASON;
  showError(fallbackTitle, {
    description: message !== fallbackTitle ? message : undefined,
    onRetry: opts?.onRetry,
  });
}

/** True for aborted / cancelled requests - these are never surfaced to the user. */
export function isSilentError(err: unknown): boolean {
  if (isCancelledError(err)) return true;
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    return name === 'AbortError' || name === 'CancelledError';
  }
  return false;
}

/** Built-in runtime errors are programmer errors - their text is not for end users. */
const INTERNAL_ERROR_NAMES = new Set([
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'EvalError',
  'URIError',
  'ZodError',
]);

const NETWORK_MESSAGE = "You seem to be offline, or the server can't be reached.";
const UNKNOWN_REASON =
  'Something unexpected happened. Try again, and contact support if it keeps happening.';

/**
 * Extract a short, human-readable message from any thrown value, or `null`
 * when there is nothing worth showing (callers then use their own fallback).
 *
 * Order: per-field validation errors -> RFC 7807 `detail` -> `title` -> `message`.
 * Never returns raw stack traces, HTML bodies, "[object Object]", infra noise
 * or programmer-error text; always secret-scrubbed.
 */
export function getErrorMessage(err: unknown): string | null {
  if (err == null || isSilentError(err)) return null;
  if (typeof err === 'string') return cleanMessage(err);
  if (typeof err !== 'object') return null;

  const obj = err as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    detail?: unknown;
    problem?: { detail?: unknown; title?: unknown; errors?: Record<string, string[]> };
  };
  if (typeof obj.name === 'string' && INTERNAL_ERROR_NAMES.has(obj.name)) return null;
  // Browser DOMException text ("Failed to execute 'stop' on 'MediaRecorder'")
  // is engine jargon: map known names to words, otherwise show nothing.
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return DOM_EXCEPTION_MESSAGES[err.name] ?? null;
  }
  if (obj.status === 0) return NETWORK_MESSAGE;
  // fetch() network failures surface as a TypeError (Chrome says "failed to fetch").
  if (err instanceof TypeError) {
    return /fetch|network|load failed/i.test(err.message) ? NETWORK_MESSAGE : null;
  }

  // Per-field validation errors are always specific and actionable - surface
  // them directly (these never count as low-signal).
  if (obj.problem?.errors && typeof obj.problem.errors === 'object') {
    const lines = Object.entries(obj.problem.errors)
      .map(([field, msgs]) =>
        Array.isArray(msgs)
          ? `${humanizeField(field)}: ${msgs.filter((m) => typeof m === 'string').join(', ')}`
          : '',
      )
      .filter(Boolean);
    const sentences = lines.slice(0, 3).map((line) => line.replace(/[.\s]+$/, ''));
    const joined = sentences.length ? cleanMessage(`${sentences.join('. ')}.`) : null;
    if (joined) return joined;
  }
  // ApiError exposes `detail` (RFC 7807, the human-readable reason) and a
  // `title`/`message`. Prefer the most specific one, in order. But a 500 (or
  // an upstream infra hiccup) often surfaces a useless technical string -
  // "command failed", "Internal Server Error", a raw stack frame, an
  // ECONNREFUSED. When the candidate is that kind of low-signal noise we
  // drop it in favour of the caller's contextual fallback ("Couldn't create
  // user") which is far more meaningful to the user.
  for (const raw of [obj.detail, obj.problem?.detail, obj.problem?.title, obj.message]) {
    const candidate = firstString(raw);
    if (!candidate) continue;
    if (isLowSignalError(candidate)) {
      if (/fetch failed|failed to fetch|load failed|network/i.test(candidate)) {
        return NETWORK_MESSAGE;
      }
      continue;
    }
    const clean = cleanMessage(candidate);
    if (clean) return clean;
  }
  // Nothing specific survived (e.g. a bare "Forbidden" or a database error
  // that was scrubbed): explain the HTTP status in plain words instead.
  if (typeof obj.status === 'number') {
    return STATUS_MESSAGES[obj.status] ?? (obj.status >= 500 ? SERVER_PROBLEM : null);
  }
  // Plain Errors from the upload/download helpers end in a code like "(413)."
  if (typeof obj.message === 'string') {
    const code = /\((\d{3})\)\.?$/.exec(obj.message.trim());
    if (code) {
      const status = Number(code[1]);
      return STATUS_MESSAGES[status] ?? (status >= 500 ? SERVER_PROBLEM : null);
    }
  }
  return null;
}

const DOM_EXCEPTION_MESSAGES: Record<string, string> = {
  NotAllowedError: 'Access is blocked. Allow it in your browser settings.',
  PermissionDeniedError: 'Access is blocked. Allow it in your browser settings.',
  SecurityError: 'Your browser blocked this. Allow access in your browser settings.',
  NotFoundError: 'No matching device was found. Connect one and try again.',
  NotReadableError: 'Another app is using the device. Close it and try again.',
  OverconstrainedError: 'The device does not support the requested settings.',
  NotSupportedError: 'Your browser does not support this.',
  InvalidStateError: 'That was not possible right now. Try again.',
  QuotaExceededError: 'There is not enough storage space.',
  DataError: 'The data could not be read.',
};

const SERVER_PROBLEM = 'The server had a problem. Try again in a moment.';

/** Plain-language reasons for statuses whose server text was too generic to show. */
const STATUS_MESSAGES: Partial<Record<number, string>> = {
  400: "Some details aren't valid. Check them and try again.",
  401: 'Your session has ended. Sign in again to continue.',
  403: "You don't have permission to do this. Ask an admin for access.",
  404: 'This item was not found. It may have been deleted or moved.',
  408: 'The request took too long. Try again.',
  409: 'This already exists or was changed by someone else. Refresh and try again.',
  413: 'The file is too large.',
  415: 'That file type is not supported.',
  422: "Some details aren't valid. Check them and try again.",
  429: 'Too many attempts. Wait a minute and try again.',
};

/**
 * A machine field name or JSON-pointer path in words a user can read:
 * `/items/0/unitPrice` -> "Unit price", `billing_email` -> "Billing email".
 * The last non-numeric segment wins. Mirrors the API's `common/humanize-field.ts`.
 */
function humanizeField(path: string): string {
  const segments = path.split(/[/.]/).filter((seg) => seg && !/^\d+$/.test(seg));
  const last = segments[segments.length - 1];
  if (!last) return 'Input';
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return 'Input';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `getErrorMessage` with a fallback - the message-only form used across the app. */
export function describeError(err: unknown, fallback = 'Something went wrong.'): string {
  return getErrorMessage(err) ?? fallback;
}

/** Plain, short, user-presentable text, or null (HTML, "[object …]", stack traces). */
function cleanMessage(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.includes('[object ')) return null;
  if (/<\/?[a-z!][^>]*>/i.test(text)) return null;
  if (/\n\s*at\s+/.test(text)) return null;
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : scrubbed;
}

function firstString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * True when an error string carries no useful information for an end user -
 * generic HTTP boilerplate, transport failures, or raw technical/infra noise
 * (stack frames, node error codes, database jargon). For these we prefer the
 * caller's action-specific fallback instead of echoing the raw string.
 */
function isLowSignalError(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  // Exact generic phrases we never want to show.
  const GENERIC = new Set([
    'error',
    'command failed',
    'request failed',
    'fetch failed',
    'failed to fetch',
    'load failed',
    'network request failed',
    'network error',
    'internal server error',
    'an unexpected error occurred.',
    'an unexpected error occurred',
    'something went wrong',
    'something went wrong.',
    'bad request',
    'unprocessable entity',
    'forbidden',
    'forbidden resource',
    'not found',
    'the requested record was not found.',
    'that record was not found. it may have been deleted or moved.',
    'conflict',
    'validation failed',
    'unauthorized',
    'too many requests',
    'database error',
    'payload too large',
    'request timeout',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
  ]);
  if (GENERIC.has(s)) return true;
  // Raw technical noise: node error codes, stack frames, DB/driver jargon.
  return (
    /\b(econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|esockettimedout)\b/i.test(s) ||
    /\n\s*at\s+/.test(raw) || // a stack trace leaked through
    s.startsWith('error:') ||
    /\bprisma\b/.test(s) ||
    /unique constraint|foreign key constraint|prisma error p\d+/i.test(s) ||
    /\b(redis|ioredis)\b/.test(s)
  );
}

/**
 * Strip likely secrets from an error string before it reaches the user.
 *
 * Upstream services (LiveKit, AWS S3, mail servers, push providers) often
 * embed API keys, JWTs, signed URLs, or even raw passwords into the
 * `message` / `detail` field of the errors they return. Without this
 * sanitiser, `describeError` would pass those straight to a toast - and
 * we have already shipped one regression where a LiveKit API key reached
 * the end user. Never again: every string flowing into `toast.error`,
 * `toast.success`, `toast.info`, or `describeError` runs through here.
 *
 * The patterns are intentionally broad - false positives ("<key>" instead
 * of a hex hash) are an acceptable cost; false negatives are not.
 */
export function scrubSecrets(input: string): string {
  if (!input) return input;
  let out = input;

  // JWTs: three base64url segments separated by dots, starting with `eyJ`.
  out = out.replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    '<token>',
  );

  // Bearer tokens - covers HTTP Authorization headers leaking into messages.
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer <token>');

  // LiveKit API keys: prefix `API` + 14+ alphanumeric chars.
  out = out.replace(/\bAPI[A-Za-z0-9]{14,}\b/g, '<key>');

  // AWS access key ids: `AKIA` / `ASIA` + 16+ uppercase alphanumerics.
  out = out.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16,}\b/g, '<key>');

  // URLs with embedded basic-auth credentials (https://user:pass@host).
  out = out.replace(
    /(https?:\/\/)[^:@/\s]+:[^@\s]+@/gi,
    '$1<redacted>@',
  );

  // Common `password=foo` / `secret: bar` / `api_key=baz` patterns.
  out = out.replace(
    /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|api[_-]?secret|token)\s*[:=]\s*([^\s,;]+)/gi,
    '$1=<redacted>',
  );

  // Trailing fallback: long opaque strings (40+ chars) that aren't UUIDs
  // or git SHAs (those are pure hex). We only scrub when the candidate
  // has both letters AND digits AND is at least 32 chars - that filter
  // catches base64-ish secrets while leaving short identifiers and pure
  // hex hashes alone.
  out = out.replace(/[A-Za-z0-9+/=_-]{32,}/g, (match) => {
    if (/^[0-9a-f]+$/i.test(match)) return match; // hex hash / UUID-ish - keep
    if (!/[A-Za-z]/.test(match) || !/[0-9]/.test(match)) return match;
    return '<key>';
  });

  return out;
}
