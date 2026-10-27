/**
 * Pure helpers for rewriting file links in a support session's responses.
 *
 * Stored files are served from public object URLs that work for anyone, for
 * ever, and never pass through the API. Inside a support session every such
 * link in a JSON response is replaced by the guarded content route
 * (`GET /files/:id/content?st=<token>`), so each open goes through AuthGuard:
 * it is logged in the organization's audit log, scoped to the granted
 * workspaces, and stops working when the grant ends. A link that doesn't
 * resolve to a file of the granted organization is replaced by a link that
 * never serves anything, so the public URL is never shown.
 */

/** The object key part of a matched link: `workspaces/<ws>/<id>-<name>`. */
const OBJECT_KEY = /^workspaces\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

/** The object key of a matched link (group 1 of `fileUrlPattern`), or null. */
export function objectKeyOfLink(rest: string): string | null {
  const cut = rest.search(/[?#&]/);
  const key = cut === -1 ? rest : rest.slice(0, cut);
  return OBJECT_KEY.test(key) ? key : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Every object key linked anywhere in `value` (plain objects, arrays, strings). */
export function collectFileLinkKeys(value: unknown, pattern: RegExp): { found: boolean; keys: Set<string> } {
  const keys = new Set<string>();
  let found = false;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 64) return;
    if (typeof v === 'string') {
      pattern.lastIndex = 0;
      for (const m of v.matchAll(pattern)) {
        found = true;
        const key = objectKeyOfLink(m[1] ?? '');
        if (key) keys.add(key);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (isPlainObject(v)) {
      for (const item of Object.values(v)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return { found, keys };
}

/**
 * A copy of `value` with every matched link replaced by `replace(key)` (key
 * null when the link has no valid object key). Never mutates `value`, which
 * may be shared with a cache. Class instances (Date, Buffer...) are kept.
 */
export function rewriteFileLinks<T>(value: T, pattern: RegExp, replace: (key: string | null) => string): T {
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v;
    if (typeof v === 'string') {
      pattern.lastIndex = 0;
      return v.replace(pattern, (_match, rest: string) => replace(objectKeyOfLink(rest)));
    }
    if (Array.isArray(v)) return v.map((item) => visit(item, depth + 1));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) out[k] = visit(item, depth + 1);
      return out;
    }
    return v;
  };
  return visit(value, 0) as T;
}

/** The guarded content link for a file in a support session. */
export function supportFileContentUrl(args: {
  apiOrigin: string;
  apiBasePath: string;
  fileId: string | null;
  token: string;
}): string {
  const origin = args.apiOrigin.replace(/\/+$/, '');
  const base = args.apiBasePath.replace(/^\/+|\/+$/g, '');
  const prefix = base ? `${origin}/${base}` : origin;
  // `unavailable` is not a file id, so that link is refused (400) and never
  // serves anything.
  if (!args.fileId) return `${prefix}/files/unavailable/content`;
  return `${prefix}/files/${encodeURIComponent(args.fileId)}/content?st=${encodeURIComponent(args.token)}`;
}
