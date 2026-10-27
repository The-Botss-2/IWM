'use client';

import React from 'react';

/**
 * Lightweight chat markdown renderer - Slack / WhatsApp style. Renders a
 * plain-text message string with inline formatting into safe React nodes (no
 * HTML injection, so it's XSS-safe by construction). Plain messages with no
 * markers render exactly as before, so existing history is unaffected.
 *
 * Supported:
 *   **bold**      -> bold
 *   *italic*      -> italic
 *   ~strike~      -> strikethrough
 *   `code`        -> inline monospace
 *   ```code```    -> fenced code block (no inline formatting inside)
 *   [label](url)  -> link
 *   bare URLs / www.links auto-link
 *   lines starting with `- ` or `* ` -> bullet (pointer) rows
 *
 * Underscores are intentionally NOT an italic marker - people type them in
 * file names, paths and code far more often than they mean emphasis, so
 * `some_var_name` stays literal. Italic comes only from the *asterisk* marker
 * that the toolbar Italic button / Ctrl+I insert.
 *
 * Newlines + leading whitespace are preserved by the caller's
 * `whitespace-pre-wrap` container, so this only injects inline structure and a
 * `\n` between lines.
 */

const URL_PATTERN = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;

/** Turn bare URLs in a plain string into safe new-tab links. */
function linkify(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = new RegExp(URL_PATTERN);
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    // Drop trailing punctuation that's almost certainly not part of the URL.
    const trimmed = raw.replace(/[),.!?;:'"]+$/, '');
    const trailing = raw.slice(trimmed.length);
    const href = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    if (isSafeHref(href)) {
      nodes.push(
        <a
          key={`${keyBase}-u${key++}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="break-all underline underline-offset-2 hover:opacity-80"
          onClick={(e) => e.stopPropagation()}
        >
          {trimmed}
        </a>,
      );
    } else {
      nodes.push(trimmed);
    }
    if (trailing) nodes.push(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function isSafeHref(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Inline markers, tried in this order so the earliest match wins (ties break by
// array order, so `bold` must precede `italic` - `**x**` should win over `*x*`).
// `code` is literal (no nested parsing); bold/italic/strike recurse so they can
// nest. Bold is `**`, italic is a single `*`; underscores are never emphasis.
const INLINE = [
  { type: 'code', re: /`([^`\n]+)`/ },
  { type: 'link', re: /\[([^\]\n]+)\]\(([^)\s]+)\)/ },
  { type: 'bold', re: /\*\*(\S(?:[^*\n]*\S)?)\*\*/ },
  { type: 'italic', re: /\*(\S(?:[^*\n]*\S)?)\*/ },
  { type: 'strike', re: /~(\S(?:[^~\n]*\S)?)~/ },
] as const;

/** Parse one line's inline formatting into React nodes. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  if (!text) return [];
  let best: { idx: number; len: number; type: string; inner: string; arg?: string } | null = null;
  for (const { type, re } of INLINE) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.idx)) {
      best = { idx: m.index, len: m[0].length, type, inner: m[1] ?? '', arg: m[2] };
    }
  }
  if (best === null) return linkify(text, keyBase);

  const before = text.slice(0, best.idx);
  const after = text.slice(best.idx + best.len);
  const nodes: React.ReactNode[] = [];
  if (before) nodes.push(...linkify(before, `${keyBase}-pre`));

  const k = `${keyBase}-${best.idx}`;
  if (best.type === 'code') {
    nodes.push(
      <code key={k} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em] dark:bg-white/15">
        {best.inner}
      </code>,
    );
  } else if (best.type === 'link') {
    const href = best.arg && best.arg.startsWith('http') ? best.arg : `https://${best.arg ?? ''}`;
    if (isSafeHref(href)) {
      nodes.push(
        <a
          key={k}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-2 hover:opacity-80"
          onClick={(e) => e.stopPropagation()}
        >
          {best.inner}
        </a>,
      );
    } else {
      nodes.push(best.inner);
    }
  } else if (best.type === 'bold') {
    nodes.push(<strong key={k}>{renderInline(best.inner, k)}</strong>);
  } else if (best.type === 'italic') {
    nodes.push(<em key={k}>{renderInline(best.inner, k)}</em>);
  } else {
    nodes.push(<del key={k}>{renderInline(best.inner, k)}</del>);
  }

  nodes.push(...renderInline(after, `${keyBase}-post`));
  return nodes;
}

// A bullet line, but never a `**bold**` line - `[-*]` must be followed by
// whitespace, so `**x**` (two asterisks, no space) is not treated as a bullet.
const BULLET_RE = /^(\s*)[-*]\s+(.+)$/;
const FENCE_OPEN_RE = /^```(\w*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

export function ChatMarkdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  // Whether a newline should be emitted before the next inline line. Code
  // blocks are block-level (display:block), so they supply their own vertical
  // separation - we suppress the surrounding "\n" text nodes around them to
  // avoid extra blank lines.
  let needSep = false;
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const open = FENCE_OPEN_RE.exec(lines[i]!);
    if (open) {
      // Find the closing fence. Only render a block if one exists; otherwise
      // the ``` is treated as literal text so it can't swallow the rest.
      let j = i + 1;
      while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j]!)) j++;
      if (j < lines.length) {
        const body = lines.slice(i + 1, j).join('\n');
        out.push(
          <code
            key={`cb${blockKey++}`}
            className="my-1 block overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-black/10 px-2.5 py-1.5 font-mono text-[0.85em] dark:bg-white/15"
          >
            {body}
          </code>,
        );
        needSep = false;
        i = j + 1;
        continue;
      }
    }

    if (needSep) out.push('\n');
    const line = lines[i]!;
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• `);
      out.push(...renderInline(bullet[2] ?? '', `l${i}`));
    } else {
      out.push(...renderInline(line, `l${i}`));
    }
    needSep = true;
    i++;
  }

  return <>{out}</>;
}
