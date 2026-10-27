import sanitizeHtml from 'sanitize-html';

/**
 * Strict allowlist sanitizer for received-mail HTML. Drops script tags,
 * inline event handlers, javascript: URLs, iframe / object / embed, and
 * any tag not on the list. Inline styles are allowed because email bodies
 * frequently style colors / borders / tables inline; a tighter pass would
 * also strip absolute positioning.
 *
 * The result is then rendered in a sandboxed iframe on the client (defense
 * in depth) so even a sanitizer bypass cannot script-attack the parent.
 */
export function sanitizeMailHtml(raw: string | null | undefined): string {
  if (!raw) return '';
  return sanitizeHtml(raw, {
    allowedTags: [
      'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
      'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption',
      'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
      'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span',
      'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
      'thead', 'tr', 'u', 'ul', 'address', 'header', 'section', 'article',
      'aside', 'footer', 'main', 'time',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'title', 'data-*'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'srcset'],
      table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
      td: ['align', 'valign', 'colspan', 'rowspan', 'width', 'height'],
      th: ['align', 'valign', 'colspan', 'rowspan', 'width', 'height'],
      tr: ['align', 'valign'],
      col: ['span', 'width'],
      colgroup: ['span', 'width'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data', 'cid'],
    },
    // Force all anchor links to open in a new tab and not leak the
    // referrer. Inline-image cid: URLs are left alone; the client rewrites
    // them to a signed download endpoint when rendering.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
    },
    disallowedTagsMode: 'discard',
  });
}
