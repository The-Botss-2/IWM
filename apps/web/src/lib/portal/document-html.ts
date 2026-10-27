'use client';

import { generateHTML } from '@tiptap/html';
import { useMemo } from 'react';

import { baseExtensions } from '@/components/editor/extensions-base';

/**
 * Read-only HTML for a portal document: the same schema and serializer as
 * the public reader at `/p/[slug]`, so a client sees exactly what a public
 * link to the document would show.
 *
 * Lives here rather than in `hooks/use-portal.ts` on purpose: it pulls in the
 * whole editor schema (lowlight grammars included), and only the reader page
 * should pay for that.
 */

type TiptapDoc = Parameters<typeof generateHTML>[0];

let extensions: ReturnType<typeof baseExtensions> | null = null;

/** Built once: `generateHTML` only reads the schema from these. */
function readerExtensions() {
  extensions ??= baseExtensions({ includeImage: true, placeholder: '' });
  return extensions;
}

/**
 * HTML for a document's Tiptap JSON: '' when there is nothing to show, null
 * when the content cannot be rendered (a node type this schema does not
 * know, for one).
 */
export function renderPortalDocumentHtml(content: unknown): string | null {
  if (!content || typeof content !== 'object') return '';
  let html: string;
  try {
    // `generateHTML` serializes only schema-permitted nodes and marks, so no
    // script or event handler survives the round trip (see `/p/[slug]`).
    html = generateHTML(content as TiptapDoc, readerExtensions());
  } catch {
    return null;
  }
  // Task-list checkboxes serialize as live inputs; in a read-only view they
  // must not toggle, by mouse or keyboard. The schema emits no other input.
  html = html.replace(/<input\b/g, '<input disabled');
  const hasText = html.replace(/<[^>]*>/g, '').trim() !== '';
  return hasText || /<img\b/i.test(html) ? html : '';
}

/** Memoized per content object, which TanStack Query keeps stable between renders. */
export function usePortalDocumentHtml(content: unknown): string | null {
  return useMemo(() => renderPortalDocumentHtml(content), [content]);
}
