import type { MailAttachment } from '@botss/shared-types';

export interface PreparedMailHtml {
  html: string;
  /** Remote images and CSS backgrounds that were held back. */
  blockedRemote: number;
}

const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\1\s*\)/gi;

function stripAngle(value: string): string {
  return value.trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

/**
 * Prepare sanitized mail HTML for the sandboxed reader iframe.
 *
 * - `cid:` inline images are rewritten to the attachment endpoint. The server
 *   sanitizer keeps `cid:` URLs and the comments claimed the client rewrote
 *   them, but nothing did, so every inline image (logos, signatures,
 *   screenshots) rendered broken.
 * - Remote images, `srcset` and CSS `url(...)` backgrounds are held back until
 *   the user asks for them. Loading them on open told every sender exactly
 *   when, where and on which device a message was read.
 * - Fixed and sticky positioning is removed so a message cannot pin content
 *   over the reading pane.
 *
 * Pure DOM work on already-sanitized HTML. Returns the input untouched where
 * DOMParser is unavailable (server render).
 */
export function prepareMailHtml(
  html: string,
  opts: {
    attachmentUrl: (attachmentId: string) => string;
    attachments: Pick<MailAttachment, 'id' | 'contentId'>[];
    loadRemote: boolean;
  },
): PreparedMailHtml {
  if (typeof DOMParser === 'undefined') return { html, blockedRemote: 0 };
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const byCid = new Map<string, string>();
  for (const a of opts.attachments) {
    if (a.contentId) byCid.set(stripAngle(a.contentId), a.id);
  }

  let blockedRemote = 0;

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (/^cid:/i.test(src)) {
      const id = byCid.get(stripAngle(src.slice(4)));
      if (id) img.setAttribute('src', opts.attachmentUrl(id));
      else img.removeAttribute('src');
      continue;
    }
    if (!opts.loadRemote && REMOTE_URL.test(src)) {
      img.setAttribute('data-blocked-src', src);
      img.removeAttribute('src');
      blockedRemote += 1;
    }
    if (!opts.loadRemote && img.hasAttribute('srcset')) {
      img.removeAttribute('srcset');
    }
  }

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
    let style = el.getAttribute('style') ?? '';
    if (!opts.loadRemote) {
      const before = style;
      style = style.replace(CSS_REMOTE_URL, 'none');
      if (style !== before) blockedRemote += 1;
    }
    style = style.replace(/position\s*:\s*(fixed|sticky)\s*;?/gi, '');
    el.setAttribute('style', style);
  }

  return { html: doc.body.innerHTML, blockedRemote };
}

/**
 * CSP for the reader iframe document. Enforces the remote-content choice even
 * if something slips past the DOM rewrite: no scripts ever, and images only
 * from inline data or our own API until the user opts in.
 */
export function mailFrameCsp(apiOrigin: string, loadRemote: boolean): string {
  const images = loadRemote ? `data: ${apiOrigin} https: http:` : `data: ${apiOrigin}`;
  return `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:; script-src 'none'; form-action 'none'`;
}
