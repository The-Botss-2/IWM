/**
 * Tiptap / ProseMirror JSON to print-ready HTML, for freezing a document into
 * the PDF that signers sign.
 *
 * Why not `@tiptap/html` with the editor's extensions: those extensions live in
 * the web app as ESM and would drag the whole Tiptap stack plus a DOM shim into
 * the CommonJS API process. This serializer is an allow-list instead: every
 * node and mark the editor can produce is mapped explicitly, text is always
 * escaped, attributes are never copied through, and anything unknown renders
 * only its children. Nothing stored in a document can inject markup into the
 * page Gotenberg renders (and Gotenberg runs with JavaScript off anyway).
 *
 * Keep the node list in step with `apps/web/src/components/editor/
 * extensions-base.ts` (StarterKit, Underline, Link, Image, Table, TaskList,
 * Callout, DateChip, Mention, ToggleBlock). An unknown node degrades to its
 * text, it never fails the render.
 */

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface PMNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Collect every image `src` so the caller can resolve them (async) first. */
export function collectImageSources(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as PMNode;
    if (node.type === 'image') {
      const src = str(node.attrs?.['src']);
      if (src) out.add(src);
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return [...out];
}

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

function renderMarks(text: string, marks: PMMark[] | undefined): string {
  let html = escapeHtml(text);
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'underline':
        html = `<u>${html}</u>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'link': {
        const href = str(mark.attrs?.['href']);
        html =
          href && SAFE_LINK.test(href.trim())
            ? `<a href="${escapeHtml(href.trim())}">${html}</a>`
            : html;
        break;
      }
      default:
        break;
    }
  }
  return html;
}

const CALLOUT_COLORS: Record<string, { bg: string; border: string }> = {
  info: { bg: '#eff6ff', border: '#93c5fd' },
  success: { bg: '#f0fdf4', border: '#86efac' },
  warning: { bg: '#fffbeb', border: '#fcd34d' },
  danger: { bg: '#fef2f2', border: '#fca5a5' },
  note: { bg: '#f8fafc', border: '#cbd5e1' },
};

function formatDateChip(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Serialise a document body. `images` maps an image's stored `src` to the
 * data URI to embed; a src missing from the map is replaced by a small
 * placeholder, because the renderer has no network access.
 */
export function tiptapToPrintHtml(doc: unknown, images: Map<string, string>): string {
  const children = (n: PMNode): string =>
    Array.isArray(n.content) ? n.content.map((c) => render(c)).join('') : '';

  const render = (raw: unknown): string => {
    if (!raw || typeof raw !== 'object') return '';
    const n = raw as PMNode;
    switch (n.type) {
      case 'doc':
        return children(n);
      case 'text':
        return renderMarks(n.text ?? '', n.marks);
      case 'paragraph': {
        const inner = children(n);
        return `<p>${inner || '&nbsp;'}</p>`;
      }
      case 'heading': {
        const level = Math.min(3, Math.max(1, Math.round(num(n.attrs?.['level'], 1))));
        return `<h${level + 1}>${children(n)}</h${level + 1}>`;
      }
      case 'hardBreak':
        return '<br>';
      case 'horizontalRule':
        return '<hr>';
      case 'blockquote':
        return `<blockquote>${children(n)}</blockquote>`;
      case 'codeBlock':
        return `<pre><code>${children(n)}</code></pre>`;
      case 'bulletList':
        return `<ul>${children(n)}</ul>`;
      case 'orderedList': {
        const start = Math.max(1, Math.round(num(n.attrs?.['start'], 1)));
        return `<ol${start !== 1 ? ` start="${start}"` : ''}>${children(n)}</ol>`;
      }
      case 'listItem':
        return `<li>${children(n)}</li>`;
      case 'taskList':
        return `<ul class="tasks">${children(n)}</ul>`;
      case 'taskItem': {
        const checked = n.attrs?.['checked'] === true;
        return `<li class="task"><span class="box">${checked ? '&#10003;' : ''}</span><div>${children(n)}</div></li>`;
      }
      case 'table':
        return `<table>${children(n)}</table>`;
      case 'tableRow':
        return `<tr>${children(n)}</tr>`;
      case 'tableCell':
      case 'tableHeader': {
        const tag = n.type === 'tableHeader' ? 'th' : 'td';
        const colspan = Math.max(1, Math.round(num(n.attrs?.['colspan'], 1)));
        const rowspan = Math.max(1, Math.round(num(n.attrs?.['rowspan'], 1)));
        const span =
          (colspan > 1 ? ` colspan="${colspan}"` : '') +
          (rowspan > 1 ? ` rowspan="${rowspan}"` : '');
        return `<${tag}${span}>${children(n)}</${tag}>`;
      }
      case 'image': {
        const src = str(n.attrs?.['src']);
        const data = src ? images.get(src) : undefined;
        if (!data) return '<p class="missing-image">[Image not available in the PDF]</p>';
        const width = Math.min(100, Math.max(10, num(n.attrs?.['width'], 100)));
        const align = str(n.attrs?.['align']);
        const margin =
          align === 'left'
            ? 'margin:0 auto 0 0'
            : align === 'right'
              ? 'margin:0 0 0 auto'
              : 'margin:0 auto';
        const alt = escapeHtml(str(n.attrs?.['alt']) ?? '');
        return `<img src="${data}" alt="${alt}" style="display:block;width:${width}%;height:auto;${margin}">`;
      }
      case 'callout': {
        const variant = str(n.attrs?.['variant']) ?? 'info';
        const c = CALLOUT_COLORS[variant] ?? CALLOUT_COLORS['info']!;
        return `<div class="callout" style="background:${c.bg};border-left:3px solid ${c.border}">${children(n)}</div>`;
      }
      case 'toggleBlock':
        return `<div class="toggle">${children(n)}</div>`;
      case 'toggleSummary':
        return `<div class="toggle-summary">${children(n)}</div>`;
      case 'toggleBody':
        return `<div class="toggle-body">${children(n)}</div>`;
      case 'mention': {
        const label = str(n.attrs?.['label']) ?? '';
        return `<span class="chip">@${escapeHtml(label)}</span>`;
      }
      case 'dateChip':
        return `<span class="chip">${escapeHtml(formatDateChip(str(n.attrs?.['date'])))}</span>`;
      default:
        // Unknown node: keep its text, drop its wrapper.
        return children(n);
    }
  };

  return render(doc);
}

/** Wrap a rendered body in a self-contained A4 page for Gotenberg. */
export function printDocument(args: {
  title: string;
  workspaceName: string;
  authorName: string;
  updatedAt: Date;
  bodyHtml: string;
}): string {
  const updated = args.updatedAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(args.title)}</title>
<style>
@page { size: A4; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Arial, "Noto Sans", sans-serif; color: #0f172a; font-size: 11pt; line-height: 1.55; margin: 0; }
header { margin-bottom: 18pt; }
.eyebrow { font-size: 8pt; letter-spacing: 0.16em; text-transform: uppercase; color: #94a3b8; margin: 0; }
h1 { font-size: 22pt; line-height: 1.2; margin: 4pt 0 6pt; }
.meta { font-size: 9pt; color: #64748b; margin: 0; }
h2 { font-size: 16pt; margin: 16pt 0 6pt; }
h3 { font-size: 13.5pt; margin: 14pt 0 5pt; }
h4 { font-size: 12pt; margin: 12pt 0 4pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
li > p { margin-bottom: 2pt; }
ul.tasks { list-style: none; padding-left: 0; }
li.task { display: flex; gap: 6pt; align-items: flex-start; }
li.task .box { flex: none; width: 10pt; height: 10pt; margin-top: 3pt; border: 1px solid #64748b; border-radius: 2px; font-size: 8pt; line-height: 9pt; text-align: center; }
blockquote { margin: 0 0 8pt; padding-left: 10pt; border-left: 3px solid #cbd5e1; color: #475569; }
pre { background: #f1f5f9; padding: 8pt; border-radius: 4pt; font-size: 9pt; white-space: pre-wrap; word-break: break-word; }
code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.92em; }
hr { border: 0; border-top: 1px solid #e2e8f0; margin: 12pt 0; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #cbd5e1; padding: 4pt 6pt; vertical-align: top; text-align: left; }
th { background: #f8fafc; font-weight: 600; }
td > p:last-child, th > p:last-child { margin-bottom: 0; }
img { max-width: 100%; margin-bottom: 8pt; page-break-inside: avoid; }
a { color: #1d4ed8; text-decoration: underline; }
.callout { padding: 8pt 10pt; border-radius: 4pt; margin: 0 0 8pt; }
.callout > p:last-child { margin-bottom: 0; }
.toggle { margin: 0 0 8pt; }
.toggle-summary { font-weight: 600; }
.toggle-body { padding-left: 12pt; }
.chip { background: #f1f5f9; border-radius: 3pt; padding: 0 3pt; }
.missing-image { color: #94a3b8; font-style: italic; }
</style>
</head>
<body>
<header>
${args.workspaceName ? `<p class="eyebrow">${escapeHtml(args.workspaceName)}</p>` : ''}
<h1>${escapeHtml(args.title)}</h1>
<p class="meta">${escapeHtml(args.authorName)} &middot; ${escapeHtml(updated)}</p>
</header>
<main>
${args.bodyHtml}
</main>
</body>
</html>`;
}
