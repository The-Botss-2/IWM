/**
 * Plain text from a Tiptap / ProseMirror JSON document, for search.
 *
 * Walks the node tree, concatenating `text` leaves and inserting line breaks
 * between block nodes so words from adjacent paragraphs never fuse together.
 * Mentions and date chips contribute their label. Unknown shapes are ignored
 * rather than thrown on, because stored content predates every extension.
 */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'bulletList',
  'orderedList',
  'taskList',
  'horizontalRule',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'callout',
  'toggleBlock',
  'image',
]);

export function tiptapToText(doc: unknown, maxLength = 200_000): string {
  const out: string[] = [];
  let length = 0;

  const push = (s: string) => {
    if (length >= maxLength || !s) return;
    const room = maxLength - length;
    const piece = s.length > room ? s.slice(0, room) : s;
    out.push(piece);
    length += piece.length;
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 200 || length >= maxLength || !node || typeof node !== 'object') return;
    const n = node as {
      type?: unknown;
      text?: unknown;
      attrs?: Record<string, unknown>;
      content?: unknown;
    };
    if (typeof n.text === 'string') push(n.text);
    const label = n.attrs?.['label'] ?? n.attrs?.['alt'];
    if (typeof label === 'string' && typeof n.text !== 'string') push(` ${label} `);
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1);
    }
    if (typeof n.type === 'string' && BLOCK_TYPES.has(n.type)) push('\n');
  };

  walk(doc, 0);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
