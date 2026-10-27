import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Pure rules and RFC 7807 problems for support sessions. The details are
 * shown to people as toasts, so they say why and avoid dashes.
 */

/** Methods a read only support session may use. Everything else is refused. */
export function isSupportReadMethod(method: string | undefined): boolean {
  const m = (method ?? '').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/** Route params that carry a secret (invite codes, share links, signing tokens). */
const SECRET_PARAM_NAMES = new Set(['token', 'code', 'slug', 'secret', 'key']);

/**
 * Path segments followed by a secret, for routes whose params aren't known
 * (the guard runs before some routers fill `req.params`). Matched case
 * insensitively, like Express routes.
 */
const SECRET_SEGMENT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(\/invites\/)[^/]+/gi, '$1:code'],
  [/(\/public\/signatures\/)[^/]+/gi, '$1:token'],
  [/(\/public\/documents\/)[^/]+/gi, '$1:slug'],
  [/(\/forms\/public\/)[^/]+/gi, '$1:slug'],
];

/**
 * The path recorded for a support request: no query string (search terms,
 * filters and the file link token can carry private text), secret path
 * params replaced by their name (`/invites/abc` becomes `/invites/:code`),
 * capped in length.
 */
export function supportAccessPath(
  url: string | undefined,
  params?: Record<string, unknown> | null,
): string {
  const raw = url ?? '';
  const cut = raw.search(/[?#]/);
  let path = cut === -1 ? raw : raw.slice(0, cut);
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      if (!SECRET_PARAM_NAMES.has(name.toLowerCase()) || typeof value !== 'string' || !value) continue;
      const encoded = encodeURIComponent(value);
      path = path
        .split('/')
        .map((segment) => (segment === value || segment === encoded ? `:${name}` : segment))
        .join('/');
    }
  }
  for (const [pattern, replacement] of SECRET_SEGMENT_PATTERNS) {
    path = path.replace(pattern, replacement);
  }
  return path.length > 300 ? path.slice(0, 300) : path;
}

/**
 * API areas a support session never opens: they hold the operator's own
 * private data (mail, chat, notifications, calls, to-dos) or mailbox
 * credentials. Relative to the API base path, lowercase.
 */
export const SUPPORT_EXCLUDED_PREFIXES: readonly string[] = [
  '/mail',
  '/chat',
  '/notifications',
  '/livekit',
  '/todos',
  '/org/mail-config',
];

/** Search kinds a support session never searches (chat and mail). */
export const SUPPORT_EXCLUDED_SEARCH_KINDS: ReadonlySet<string> = new Set([
  'chat_message',
  'chat_room',
  'file',
  'mail',
]);

function normalizeRoutePath(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Keep the raw path; a malformed escape can't match a route anyway.
  }
  p = p.toLowerCase().replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Whether a support request targets an excluded area. `path` is the request
 * path (no query string); `controllerPath` the handler's controller route
 * (`@Controller('mail/messages')`), checked too so a differently written URL
 * can't slip past the prefix match. Case insensitive, like Express routing.
 */
export function isSupportExcludedPath(
  path: string,
  apiBasePath: string,
  controllerPath?: string | readonly string[] | null,
): boolean {
  const base = normalizeRoutePath(apiBasePath);
  const full = normalizeRoutePath(path);
  const relative = base !== '/' && underPrefix(full, base) ? full.slice(base.length) || '/' : full;
  const candidates = [relative];
  const controllers = Array.isArray(controllerPath) ? controllerPath : controllerPath ? [controllerPath] : [];
  for (const c of controllers) {
    if (typeof c === 'string') candidates.push(normalizeRoutePath(c));
  }
  return candidates.some((candidate) => SUPPORT_EXCLUDED_PREFIXES.some((prefix) => underPrefix(candidate, prefix)));
}

/**
 * Prisma operations a support request may never run. Anything that writes:
 * the model writes plus raw statements. `queryRaw` stays allowed because the
 * read paths (search, finance summary) use it; nothing writes through it.
 */
const SUPPORT_BLOCKED_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'executeRaw',
  'executeRawUnsafe',
  'runCommandRaw',
]);

export function isSupportBlockedAction(action: string | undefined): boolean {
  return SUPPORT_BLOCKED_ACTIONS.has(action ?? '');
}

export function supportNotAllowed(): ForbiddenException {
  return new ForbiddenException({
    title: 'Support session not allowed',
    status: 403,
    detail: 'Only platform operators can open a support session.',
    code: 'support-not-allowed',
  });
}

export function supportSessionInvalid(): ForbiddenException {
  return new ForbiddenException({
    title: 'Support session not valid',
    status: 403,
    detail: "This support session isn't valid for your sign in. Open it again from the Organizations page.",
    code: 'support-session-invalid',
  });
}

export function supportSessionEnded(): ForbiddenException {
  return new ForbiddenException({
    title: 'Support session ended',
    status: 403,
    detail: 'This support session has ended because the organization revoked access, the grant expired, or the organization is suspended.',
    code: 'support-session-ended',
  });
}

export function supportReadOnly(): ForbiddenException {
  return new ForbiddenException({
    title: 'Read only support session',
    status: 403,
    detail: "Support sessions are read only, so changes can't be saved.",
    code: 'support-read-only',
  });
}

export function supportExcluded(): ForbiddenException {
  return new ForbiddenException({
    title: 'Not available in a support session',
    status: 403,
    detail: 'Mail, chat, notifications, calls and todos are private to each person, so support sessions cannot open them.',
    code: 'support-excluded',
  });
}

export function supportLogUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    title: 'Service temporarily unavailable',
    status: 503,
    detail: "Couldn't record this request in the organization's audit log, so it was not run. Please try again.",
    code: 'support-log-unavailable',
  });
}
