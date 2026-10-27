/**
 * Slack-style search modifiers typed into the search box.
 *
 *   design review from:@sara in:#marketing has:file after:2026-09-01 before:2026-09-30
 *
 * `from:` and `in:` values are names, resolved to ids by the page against the
 * workspace members and the user's chat rooms. `in:@sara` means the direct
 * message with Sara. Quoted values allow spaces: `from:"Sara Khan"`,
 * `in:"design team"`. Dates must be YYYY-MM-DD. `has:` takes `file` or `link`.
 *
 * The free text supports `"exact phrase"` and `-excluded` words; the server
 * turns it into a prefix full-text query.
 */
export type SearchHas = 'file' | 'link';

export interface ParsedSearch {
  text: string;
  from: string | null;
  /** A channel or group name (`in:#design`). */
  in: string | null;
  /** A person whose direct message to search (`in:@sara`). */
  inDm: string | null;
  has: SearchHas | null;
  after: string | null;
  before: string | null;
}

const MODIFIER = /(^|\s)(from|in|has|after|before):(?:"([^"]*)"|(\S+))/gi;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const EMPTY: ParsedSearch = {
  text: '',
  from: null,
  in: null,
  inDm: null,
  has: null,
  after: null,
  before: null,
};

export function parseSearchQuery(input: string): ParsedSearch {
  const result: ParsedSearch = { ...EMPTY };
  const text = input.replace(MODIFIER, (_match, lead: string, key: string, quoted?: string, bare?: string) => {
    const raw = (quoted ?? bare ?? '').trim();
    const k = key.toLowerCase() as 'from' | 'in' | 'has' | 'after' | 'before';
    if (k === 'from') result.from = raw.replace(/^@/, '') || null;
    else if (k === 'in') {
      if (raw.startsWith('@')) result.inDm = raw.slice(1) || null;
      else result.in = raw.replace(/^#/, '') || null;
    } else if (k === 'has') {
      const v = raw.toLowerCase();
      if (v === 'file' || v === 'files' || v === 'attachment') result.has = 'file';
      else if (v === 'link' || v === 'links' || v === 'url') result.has = 'link';
    } else if (ISO_DATE.test(raw)) result[k] = raw;
    return lead;
  });
  result.text = text.replace(/\s+/g, ' ').trim();
  return result;
}

/** True when the box holds any `from:` / `in:` / `has:` / date modifier. */
export function hasSearchModifiers(input: string): boolean {
  MODIFIER.lastIndex = 0;
  const found = MODIFIER.test(input);
  MODIFIER.lastIndex = 0;
  return found;
}

/** True when a parsed query narrows by anything besides its text. */
export function hasSearchFilters(parts: ParsedSearch): boolean {
  return Boolean(parts.from || parts.in || parts.inDm || parts.has || parts.after || parts.before);
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Rebuild the box text from parts, e.g. after removing one filter chip. */
export function formatSearchQuery(parts: ParsedSearch): string {
  return [
    parts.text,
    parts.from ? `from:@${quote(parts.from)}` : '',
    parts.in ? `in:#${quote(parts.in)}` : '',
    parts.inDm ? `in:@${quote(parts.inDm)}` : '',
    parts.has ? `has:${parts.has}` : '',
    parts.after ? `after:${parts.after}` : '',
    parts.before ? `before:${parts.before}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Lower-case without changing the string's length: characters whose JS
 * lower-case form is longer (Turkish 'İ' becomes "i" + U+0307) stay as they
 * are, so positions found in the result are valid in the original text.
 * Mirrors `lowerSameLength` in apps/api/src/search/search-sql.ts.
 */
export function lowerSameLength(text: string): string {
  return [...text]
    .map((ch) => {
      const lower = ch.toLowerCase();
      return lower.length === ch.length ? lower : ch;
    })
    .join('');
}

/**
 * The words a result was matched on: letter/digit runs of the text, minus
 * `-excluded` words. Mirrors the server's tokenizer so highlights line up.
 */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  const chunks = text.match(/-?"[^"]*"|\S+/g) ?? [];
  for (const chunk of chunks) {
    if (chunk.length > 1 && chunk.startsWith('-')) continue;
    for (const word of chunk.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []) {
      const lower = lowerSameLength(word);
      if (!out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

/**
 * Split `text` into segments marking case-insensitive matches of any word in
 * `term`. Search matches word prefixes ("inv" finds "invoice"), so the typed
 * part of each word is what gets marked.
 */
export function highlightSegments(text: string, term: string): { value: string; match: boolean }[] {
  const terms = searchTerms(term).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [{ value: text, match: false }];
  const lower = lowerSameLength(text);
  const out: { value: string; match: boolean }[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    const hit = terms.find((t) => lower.startsWith(t, i));
    if (!hit) {
      i += 1;
      continue;
    }
    if (i > plainStart) out.push({ value: text.slice(plainStart, i), match: false });
    out.push({ value: text.slice(i, i + hit.length), match: true });
    i += hit.length;
    plainStart = i;
  }
  if (plainStart < text.length) out.push({ value: text.slice(plainStart), match: false });
  return out;
}
