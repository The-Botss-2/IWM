import { Prisma } from '@botss/database';

/**
 * Full-text search building blocks for global search. Pure: no Prisma calls,
 * so `scripts/check-search.ts` can check them without a database.
 *
 * `FTS` repeats the expression of every `*_fts_idx` GIN index from
 * packages/database/prisma/migrations/20261026130000_search_fulltext_indexes
 * CHARACTER FOR CHARACTER. Postgres only uses an expression index when the
 * query spells the same expression, so an "equivalent" rewrite here silently
 * turns every search into a sequential scan. Columns are unqualified on
 * purpose (the index has no table alias); every query that uses one keeps the
 * indexed table as the only relation whose columns those names can resolve to.
 * The check script fails if a fragment is not found verbatim in the migration.
 */
export const FTS_EXPRESSIONS = {
  message: `to_tsvector('simple'::regconfig, left(coalesce("content", ''), 100000))`,
  chatFile: `to_tsvector('simple'::regconfig, translate("fileName", '._-', '   '))`,
  file: `to_tsvector('simple'::regconfig, translate("filename", '._-', '   '))`,
  document: `setweight(to_tsvector('simple'::regconfig, coalesce("title", '')), 'A') || setweight(to_tsvector('simple'::regconfig, left(coalesce("contentText", ''), 100000)), 'C')`,
  task: `setweight(to_tsvector('simple'::regconfig, coalesce("title", '')), 'A') || setweight(to_tsvector('simple'::regconfig, left(coalesce("description", ''), 100000)), 'B')`,
  project: `setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A') || setweight(to_tsvector('simple'::regconfig, left(coalesce("description", ''), 100000)), 'B')`,
  lead: `setweight(to_tsvector('simple'::regconfig, coalesce("name", '') || ' ' || coalesce("company", '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce("email", '')), 'B') || setweight(to_tsvector('simple'::regconfig, left(coalesce("notes", ''), 100000)), 'C')`,
  client: `setweight(to_tsvector('simple'::regconfig, coalesce("name", '') || ' ' || coalesce("legalName", '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce("email", '')), 'B') || setweight(to_tsvector('simple'::regconfig, left(coalesce("notes", ''), 100000)), 'C')`,
} as const;

export type FtsKind = keyof typeof FTS_EXPRESSIONS;

/** The same expressions as SQL fragments, wrapped in parentheses for `@@`/`||` safety. */
export const FTS: Record<FtsKind, Prisma.Sql> = Object.fromEntries(
  Object.entries(FTS_EXPRESSIONS).map(([k, expr]) => [k, Prisma.raw(`(${expr})`)]),
) as Record<FtsKind, Prisma.Sql>;

/** Shorter ILIKE text than this is left to the tsquery: a trigram index can't serve it. */
export const MIN_LIKE_LENGTH = 3;

/** Most words a query contributes; keeps a pasted paragraph from becoming a huge tsquery. */
export const MAX_QUERY_TOKENS = 8;

/**
 * A word: a letter or digit in any script, then letters, digits and combining
 * marks (so a decomposed "é" or "i\u0307" stays one word). Everything else,
 * tsquery syntax included, separates words.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/**
 * Words exactly as typed. NOT lower-cased here: to_tsquery('simple', ...)
 * lower-cases with the same database rules as to_tsvector did when the row
 * was indexed. JS rules differ (`'İ'.toLowerCase()` is "i" + U+0307, while
 * Postgres gives "i" or keeps "İ" depending on the locale), so a JS-lowered
 * "İstanbul" would never match.
 */
function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** A chunk of the search box: a word or a `"quoted phrase"`, possibly negated with `-`. */
interface Chunk {
  raw: string;
  phrase: boolean;
  negated: boolean;
}

function chunks(text: string): Chunk[] {
  const out: Chunk[] = [];
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== undefined) {
      out.push({ raw: m[2], phrase: true, negated: m[1] === '-' });
    } else {
      const bare = m[3]!;
      const negated = bare.length > 1 && bare.startsWith('-');
      out.push({ raw: negated ? bare.slice(1) : bare, phrase: false, negated });
    }
  }
  return out;
}

/**
 * The search box text as a prefix tsquery for `to_tsquery('simple'::regconfig, $1)`.
 *
 *   design rev          -> design:* & rev:*
 *   "design review" q3  -> design <-> review:* & q3:*
 *   invoice -draft      -> invoice:*  (exclusions are applied separately,
 *                                      see negatedTsQuery / matchSql)
 *   q 3                 -> q & 3      (a one-character prefix would match
 *                                      half the table, so it must match whole)
 *
 * Only letter/digit runs survive, so tsquery operators typed by the user
 * (`& | ! : ( ) '`) can never change the query's shape or make it fail to
 * parse. Returns null when nothing positive is left (the caller then matches
 * with ILIKE only). The result is always passed as a bound parameter.
 *
 * Exclusions never go into this query: if every positive word were dropped by
 * the parser (`²` has no lexeme), `x & !draft` would collapse to `!draft` and
 * match every row without "draft". They still use up the word budget.
 */
/** `word:*`, except one-character words, which match exactly. */
function prefix(word: string): string {
  return [...word].length > 1 ? `${word}:*` : word;
}

export function toPrefixTsQuery(text: string): string | null {
  const parts: string[] = [];
  let budget = MAX_QUERY_TOKENS;
  let positives = 0;
  for (const c of chunks(text)) {
    if (budget <= 0) break;
    const ws = words(c.raw).slice(0, budget);
    if (ws.length === 0) continue;
    budget -= ws.length;
    if (c.negated) {
      // Excluded words count toward the budget but are matched by
      // negatedTsQuery, never here.
      continue;
    } else if (c.phrase) {
      parts.push(ws.map((w, i) => (i === ws.length - 1 ? prefix(w) : w)).join(' <-> '));
      positives += 1;
    } else {
      for (const w of ws) parts.push(prefix(w));
      positives += ws.length;
    }
  }
  return positives > 0 ? parts.join(' & ') : null;
}

/**
 * Lower-case without changing the string's length: characters whose JS
 * lower-case form is longer (Turkish 'İ' becomes "i" + U+0307) stay as they
 * are. Positions found in the result are then valid in the original text.
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
 * The positive words of the box, lower-cased (length-preserving), for
 * snippets and highlighting.
 */
export function searchTokens(text: string): string[] {
  const out: string[] = [];
  for (const c of chunks(text)) {
    if (c.negated) continue;
    for (const w of words(c.raw).map(lowerSameLength)) {
      if (out.length >= MAX_QUERY_TOKENS) return out;
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}

/** The text an ILIKE branch looks for: the box minus negated chunks and quote marks. */
export function likeText(text: string): string {
  return chunks(text)
    .filter((c) => !c.negated)
    .map((c) => c.raw.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Negated words as an OR tsquery (`draft | old`), applied to the ILIKE branch too. */
export function negatedTsQuery(text: string): string | null {
  const neg: string[] = [];
  for (const c of chunks(text)) {
    if (!c.negated) continue;
    const ws = words(c.raw);
    if (ws.length === 1) neg.push(ws[0]!);
    else if (ws.length > 1) neg.push(`(${ws.join(' <-> ')})`);
  }
  return neg.length > 0 ? neg.slice(0, MAX_QUERY_TOKENS).join(' | ') : null;
}

/**
 * A short excerpt of `text` centered on the first occurrence of any of
 * `tokens`. Both sides are lowered with lowerSameLength so the match index
 * is a valid index into the original text.
 */
export function snippetAround(
  text: string | null | undefined,
  tokens: string[],
  radius = 70,
): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const lower = lowerSameLength(flat);
  let at = -1;
  let len = 0;
  for (const token of tokens) {
    const i = lower.indexOf(lowerSameLength(token));
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      len = token.length;
    }
  }
  if (at === -1) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}...` : flat;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + len + radius);
  return `${start > 0 ? '...' : ''}${flat.slice(start, end)}${end < flat.length ? '...' : ''}`;
}

/** Escape LIKE wildcards so user text matches literally (Postgres' default escape is `\`). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `text%` for a starts-with match (trigram-indexable as ILIKE). */
export function prefixPattern(text: string): string {
  return `${escapeLike(text)}%`;
}

/** `%text%` for a contains match. */
export function likePattern(text: string): string {
  return `%${escapeLike(text)}%`;
}

/**
 * Everything a kind query needs to match and rank the box text. Null when the
 * box is empty (a filter-only search): no text predicate, recency-only score.
 */
export interface TextMatch {
  /** Prefix tsquery, or null when only ILIKE can match. */
  tsq: string | null;
  /** Negated words, excluded from both branches. */
  neg: string | null;
  /** The ILIKE text (unescaped), or '' when only negations were typed. */
  like: string;
  /** Positive words, for snippets. */
  tokens: string[];
  /**
   * Excluded words and phrases as typed (`-draft -"old copy"` gives
   * ['draft', 'old copy']), for the Prisma-backed kinds' `NOT contains`.
   */
  negWords: string[];
}

/**
 * The `-excluded` words and phrases of the box, for the Prisma kinds'
 * substring exclusion. One entry per chunk: `-noreply@acme.com` stays whole
 * (split into words, "com" would drop nearly everything). Entries shorter
 * than MIN_LIKE_LENGTH are skipped: as substrings, `-a` or `-to` would drop
 * almost every row. The SQL kinds exclude whole lexemes via negatedTsQuery.
 */
export function negatedWords(text: string): string[] {
  const out: string[] = [];
  for (const c of chunks(text)) {
    if (!c.negated) continue;
    let entry: string | null = null;
    if (c.phrase) {
      // A punctuation-only phrase (`-"..."`) excludes nothing, as unquoted.
      entry = words(c.raw).length > 0 ? c.raw.trim() || null : null;
    } else {
      const ws = words(c.raw);
      if (ws.length === 1) entry = ws[0]!;
      // Trim edge punctuation so `-<noreply@acme.com>,` still matches the address.
      else if (ws.length > 1) entry = c.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}\p{M}]+$/gu, '');
    }
    if (entry && [...entry].length >= MIN_LIKE_LENGTH) out.push(entry);
  }
  return out.slice(0, MAX_QUERY_TOKENS);
}

export function textMatch(q: string): TextMatch | null {
  const text = q.trim();
  if (!text) return null;
  return {
    tsq: toPrefixTsQuery(text),
    neg: negatedTsQuery(text),
    like: likeText(text),
    tokens: searchTokens(text),
    negWords: negatedWords(text),
  };
}

const tsquery = (q: string) => Prisma.sql`to_tsquery('simple'::regconfig, ${q})`;

/**
 * The text predicate for one kind: the FTS index OR a trigram-indexed ILIKE
 * on each listed column. Every branch of the OR has an index, so Postgres can
 * BitmapOr them instead of scanning. TRUE when there is no text (a
 * filter-only search), FALSE when only `-excluded` words were typed. Text
 * shorter than MIN_LIKE_LENGTH skips the ILIKE branches when a tsquery
 * exists: trigrams can't index it, so it would force a full scan.
 */
export function matchSql(fts: Prisma.Sql, likeColumns: Prisma.Sql[], m: TextMatch | null): Prisma.Sql {
  if (!m) return Prisma.sql`TRUE`;
  const branches: Prisma.Sql[] = [];
  if (m.tsq) branches.push(Prisma.sql`${fts} @@ ${tsquery(m.tsq)}`);
  if (m.like && (!m.tsq || [...m.like].length >= MIN_LIKE_LENGTH)) {
    const pattern = likePattern(m.like);
    for (const col of likeColumns) branches.push(Prisma.sql`${col} ILIKE ${pattern}`);
  }
  // Only `-excluded` words typed: nothing positive to match, so no hits
  // (rather than every row without those words).
  if (branches.length === 0) return Prisma.sql`FALSE`;
  const positive = Prisma.sql`(${Prisma.join(branches, ' OR ')})`;
  if (!m.neg) return positive;
  return Prisma.sql`(${positive} AND NOT (${fts} @@ ${tsquery(m.neg)}))`;
}

/** Recency boost: 0.15 for something from today, halving at about a month. */
export function recencySql(at: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(0.15 / (1 + greatest(0, extract(epoch from ((now() AT TIME ZONE 'UTC') - ${at}))) / 2592000.0))`;
}

/**
 * Relevance score, highest first:
 *   greatest(ts_rank_cd(fts, q, 32), 0.01)
 *                                     0..1 for rows the tsquery matched; rows only
 *                                     the ILIKE branch matched rank 0 and floor at 0.01
 *   + 1.0 exact / 0.5 prefix title    so "Acme" ranks the client named Acme first
 *   + recency                         ties go to the fresher row
 * A filter-only search (no text) scores by recency alone. One tsvector is
 * built per scored row; the caller bounds how many rows get scored.
 */
export function scoreSql(opts: {
  fts: Prisma.Sql;
  title: Prisma.Sql | null;
  at: Prisma.Sql;
  match: TextMatch | null;
}): Prisma.Sql {
  const { fts, title, at, match } = opts;
  const recency = recencySql(at);
  if (!match) return Prisma.sql`(${recency})::float8`;
  const rank = match.tsq
    ? Prisma.sql`greatest(ts_rank_cd(${fts}, ${tsquery(match.tsq)}, 32), 0.01)`
    : Prisma.sql`0.01`;
  const titleBoost =
    title && match.like
      ? Prisma.sql`CASE WHEN lower(${title}) = lower(${match.like}) THEN 1.0 WHEN ${title} ILIKE ${prefixPattern(match.like)} THEN 0.5 ELSE 0 END`
      : Prisma.sql`0`;
  return Prisma.sql`((${rank}) + (${titleBoost}) + ${recency})::float8`;
}

/** JS twin of `scoreSql` for the kinds still queried through Prisma (rooms, people, mail). */
export function scoreInJs(title: string, at: Date | null | undefined, match: TextMatch | null): number {
  const ageDays = at ? Math.max(0, (Date.now() - at.getTime()) / 86_400_000) : 365;
  const recency = 0.15 / (1 + ageDays / 30);
  if (!match) return recency;
  const t = title.toLowerCase();
  const like = match.like.toLowerCase();
  const titleBoost = like && t === like ? 1 : like && t.startsWith(like) ? 0.5 : 0;
  const rank = match.tokens.length > 0 && match.tokens.every((w) => t.includes(w)) ? 0.1 : 0.01;
  return rank + titleBoost + recency;
}
