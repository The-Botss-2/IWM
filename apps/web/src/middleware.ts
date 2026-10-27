import { NextResponse, type NextRequest } from 'next/server';

/**
 * Strict, nonce-based Content-Security-Policy.
 *
 * A fresh nonce is minted per request and threaded two ways:
 *   1. onto the *request* headers as `x-nonce`, so server components (the
 *      root layout's inline theme script) can stamp the same nonce, and
 *   2. into the `script-src` directive of the CSP we return.
 *
 * `'strict-dynamic'` lets Next's own nonce-tagged bootstrap scripts load the
 * rest of the chunk graph without us having to allowlist every hashed file.
 *
 * Deliberate relaxations (documented so nobody "tightens" them and breaks prod):
 *   - `style-src 'unsafe-inline'`: next/font and Tailwind inject inline styles
 *     that can't all be nonced; style-injection XSS is low-severity, so this is
 *     the accepted trade-off.
 *   - `connect-src https: wss:`: the app calls the API over HTTPS and runs a
 *     Socket.IO (wss) connection for chat/presence; pinning exact origins here
 *     would break as soon as the API host changes.
 *   - `img-src data: blob: https:`: chat/editor previews use blob: and data:
 *     URLs and images come from object storage / CDN origins.
 *
 * NOTE: reading `x-nonce` via `headers()` in the layout opts every route into
 * dynamic rendering - that's the intended cost of a strict CSP.
 */
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https:`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "media-src 'self' blob: https:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function middleware(request: NextRequest) {
  // base64 keeps the nonce header-safe; randomUUID is available in the edge runtime.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Setting the CSP on the request headers too lets Next propagate the nonce
  // onto the scripts it injects itself.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Run on every page request except Next's static assets, the image
    // optimizer, and favicon - those never carry inline scripts and skipping
    // them keeps static asset caching intact.
    {
      source: '/((?!_next/static|_next/image|favicon.ico|branding).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
